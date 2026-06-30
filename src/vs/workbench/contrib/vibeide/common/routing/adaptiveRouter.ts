/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../vibeLog.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { TaskContext, RoutingDecision, TaskType } from '../modelRouter.js';
import { ModelSelection, ProviderName, localProviderNames } from '../vibeideSettingsTypes.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../vibeideSettingsService.js';
import { IVibeideTelemetryService } from '../telemetry/telemetryService.js';
import { TelemetryAnalyticsService } from '../telemetry/telemetryAnalytics.js';
import { getModelCapabilities } from '../modelCapabilities.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

export const IAdaptiveModelRouter = createDecorator<IAdaptiveModelRouter>('AdaptiveModelRouter');

export interface IAdaptiveModelRouter {
	readonly _serviceBrand: undefined;
	route(context: TaskContext): Promise<RoutingDecision>;
	updateFromTelemetry(): Promise<void>;
}

/**
 * Adaptive Model Router
 * PHILOSOPHY: Simple base rules + learned adjustments from telemetry
 * Start with reasonable defaults, improve continuously from real usage
 */
export class AdaptiveModelRouter extends Disposable implements IAdaptiveModelRouter {
	readonly _serviceBrand: undefined;

	private learnedAdjustments: Map<string, number> = new Map();
	private analytics: TelemetryAnalyticsService;
	private updateInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@IVibeideTelemetryService private readonly telemetryService: IVibeideTelemetryService
	) {
		super();
		this.analytics = new TelemetryAnalyticsService(telemetryService);

		// Update learned adjustments every hour
		this.updateInterval = setInterval(() => {
			this.updateFromTelemetry().catch(err => {
				vibeLog.warn('adaptiveRouter', '[AdaptiveRouter] Failed to update from telemetry:', err);
			});
		}, 60 * 60 * 1000); // 1 hour

		this._register({
			dispose: () => {
				if (this.updateInterval) {
					clearInterval(this.updateInterval);
				}
			}
		});

		// Initial update
		this.updateFromTelemetry().catch(err => {
			vibeLog.warn('adaptiveRouter', '[AdaptiveRouter] Failed initial telemetry update:', err);
		});
	}

	/**
	 * Route to the best model for a given task context
	 */
	async route(context: TaskContext): Promise<RoutingDecision> {
		const startTime = performance.now();
		const eventId = generateUuid();

		// Phase 1: Fast paths (unchanged)
		if (context.userOverride) {
			return this._handleUserOverride(context);
		}
		if (context.requiresPrivacy) {
			return this._routePrivacyMode(context);
		}

		const settingsState = this.settingsService.state;

		// Phase 2: Get candidate models
		const candidates = this._getCandidateModels(context, settingsState);

		if (candidates.length === 0) {
			return {
				modelSelection: { providerName: 'auto', modelName: 'auto' },
				confidence: 0.0,
				reasoning: 'No models available. Please configure at least one model provider in settings.',
				qualityTier: 'abstain',
				shouldAbstain: true,
				abstainReason: 'No models configured',
			};
		}

		// Phase 3: Score models (simple base scoring + learned adjustments)
		const scored = candidates.map(model => {
			const baseScore = this._computeBaseScore(model, context, settingsState);
			const learnedAdjustment = this._getLearnedAdjustment(model, context);
			const finalScore = baseScore + learnedAdjustment;

			return {
				model,
				baseScore,
				learnedAdjustment,
				finalScore
			};
		});

		// Phase 4: Select best model
		scored.sort((a, b) => b.finalScore - a.finalScore);
		const best = scored[0];
		const fallbackChain = scored.slice(1, 4).map(s => s.model);

		// Phase 5: Record decision for learning (non-blocking)
		this._recordRoutingDecision(context, best, scored, eventId, startTime).catch(err => {
			vibeLog.warn('adaptiveRouter', '[AdaptiveRouter] Failed to record routing decision:', err);
		});

		const confidence = Math.min(1.0, best.finalScore / 100);
		const reasoning = this._explainDecision(best, scored);

		return {
			modelSelection: best.model,
			confidence,
			reasoning,
			fallbackChain,
			qualityTier: this._estimateQualityTier(best.finalScore),
			timeoutMs: this._getModelTimeout(best.model, context)
		};
	}

	/**
	 * Update learned adjustments from telemetry
	 * Called periodically (every hour) to learn from telemetry
	 */
	async updateFromTelemetry(): Promise<void> {
		const taskTypes: TaskType[] = ['chat', 'code', 'vision', 'pdf', 'general'];

		for (const taskType of taskTypes) {
			const rankings = await this.analytics.computeModelRankings(taskType);

			// Update learned adjustments based on actual performance
			rankings.forEach((modelPerf, index) => {
				const key = this._makeAdjustmentKey(modelPerf.model as ModelSelection, { taskType });

				// Compute adjustment: reward high-quality models, penalize low-quality
				// Top model: +50, second: +25, third: 0, rest: negative
				let adjustment = 0;
				if (index === 0) { adjustment = 50; }
				else if (index === 1) { adjustment = 25; }
				else if (index === 2) { adjustment = 0; }
				else { adjustment = -25 * (index - 2); }

				// Weight by sample size (more data = more confidence)
				const confidence = Math.min(modelPerf.sampleSize / 100, 1);
				adjustment *= confidence;

				this.learnedAdjustments.set(key, adjustment);
			});
		}

		// Save learned adjustments (could persist to storage)
		vibeLog.info('adaptiveRouter', '[AdaptiveRouter] Updated learned adjustments:', this.learnedAdjustments.size);
	}

	/**
	 * Handle user override
	 */
	private _handleUserOverride(context: TaskContext): RoutingDecision {
		return {
			modelSelection: context.userOverride!,
			confidence: 1.0,
			reasoning: 'User explicitly selected this model',
			qualityTier: 'standard',
		};
	}

	/**
	 * Route to privacy mode (local models only)
	 */
	private _routePrivacyMode(context: TaskContext): RoutingDecision {
		const settingsState = this.settingsService.state;
		const candidates = this._getCandidateModels(context, settingsState)
			.filter(m => (localProviderNames as readonly string[]).includes(m.providerName));

		if (candidates.length === 0) {
			return {
				modelSelection: { providerName: 'auto', modelName: 'auto' },
				confidence: 0.0,
				reasoning: 'Privacy mode requires local models, but no local models are configured.',
				qualityTier: 'abstain',
				shouldAbstain: true,
				abstainReason: 'No local models available for privacy mode',
			};
		}

		// Score and select best local model
		const scored = candidates.map(model => ({
			model,
			score: this._computeBaseScore(model, context, settingsState)
		}));

		scored.sort((a, b) => b.score - a.score);
		const best = scored[0];

		return {
			modelSelection: best.model,
			confidence: 0.8,
			reasoning: 'Privacy mode: selected best available local model',
			qualityTier: 'standard',
		};
	}

	/**
	 * Get candidate models for routing
	 */
	private _getCandidateModels(context: TaskContext, settingsState: VibeideSettingsState): ModelSelection[] {
		const models: ModelSelection[] = [];

		// Get all configured models from settings
		for (const providerName of Object.keys(settingsState.settingsOfProvider) as ProviderName[]) {
			const providerSettings = settingsState.settingsOfProvider[providerName];
			if (!providerSettings || !providerSettings._didFillInProviderSettings) { continue; }

			for (const modelInfo of providerSettings.models || []) {
				if (modelInfo.isHidden) { continue; }

				models.push({
					providerName,
					modelName: modelInfo.modelName
				});
			}
		}

		return models.filter(m => m.providerName !== 'auto');
	}

	/**
	 * SIMPLIFIED BASE SCORING (100 lines total, not 632)
	 */
	private _computeBaseScore(model: ModelSelection, context: TaskContext, settingsState: VibeideSettingsState): number {
		let score = 0;

		const capabilities = getModelCapabilities(
			model.providerName as ProviderName,
			model.modelName,
			settingsState.overridesOfModel
		);

		// 1. Base quality tier (20 lines)
		score += this._getQualityTier(capabilities); // 10-50 points

		// 2. Task capability match (20 lines)
		// Note: Vision/PDF support is determined by provider, not model capabilities
		// For now, we'll check provider name (simplified)
		const isVisionProvider = model.providerName === 'anthropic' || model.providerName === 'openAI' || model.providerName === 'gemini';
		if (context.hasImages && !isVisionProvider) { score -= 100; }
		if (context.hasPDFs && !isVisionProvider) { score -= 100; }
		if (context.requiresComplexReasoning && !capabilities.reasoningCapabilities) { score -= 50; }
		if (context.hasCode && capabilities.supportsFIM) { score += 30; }

		// 3. Context window fit (10 lines)
		const estimatedTokens = context.contextSize || 0;
		if (estimatedTokens > capabilities.contextWindow) { score -= 200; }
		if (estimatedTokens > capabilities.contextWindow * 0.8) { score -= 50; }

		// 4. Cost consideration (10 lines)
		const isLocal = (localProviderNames as readonly string[]).includes(model.providerName);
		if (isLocal) {
			score += 20; // Prefer free local models slightly
		} else {
			// Penalize expensive models (simplified - would need actual cost data)
			score -= 10;
		}

		// 5. Latency consideration (10 lines)
		const expectedLatency = this._estimateLatency(capabilities, context);
		if (expectedLatency > 10_000) { score -= 30; } // Penalize slow models

		// 6. Local-first mode bonus
		const localFirstAI = settingsState.globalSettings.localFirstAI ?? false;
		if (localFirstAI && isLocal) {
			score += 50; // Heavy bonus for local models in local-first mode
		}

		return score;
	}

	/**
	 * Get quality tier score (10-50 points)
	 */
	private _getQualityTier(capabilities: ReturnType<typeof getModelCapabilities>): number {
		// Simplified: estimate from context window and reasoning capabilities
		if (capabilities.contextWindow >= 200_000) { return 50; } // Large context = high tier
		if (capabilities.contextWindow >= 100_000) { return 40; }
		if (capabilities.reasoningCapabilities) { return 45; } // Reasoning = high tier
		if (capabilities.contextWindow >= 32_000) { return 30; }
		return 10;
	}

	/**
	 * Estimate expected latency
	 */
	private _estimateLatency(capabilities: ReturnType<typeof getModelCapabilities>, context: TaskContext): number {
		// Simplified estimation
		const isLocal = context.userOverride ? (localProviderNames as readonly string[]).includes(context.userOverride.providerName) : false;
		const baseLatency = isLocal ? 2000 : 1000;
		const contextPenalty = (context.contextSize || 0) / 1000; // 1ms per 1k tokens
		return baseLatency + contextPenalty;
	}

	/**
	 * Get learned adjustment from telemetry
	 */
	private _getLearnedAdjustment(model: ModelSelection, context: TaskContext): number {
		const key = this._makeAdjustmentKey(model, context);
		return this.learnedAdjustments.get(key) ?? 0;
	}

	/**
	 * Make adjustment key for learned adjustments map
	 */
	private _makeAdjustmentKey(model: ModelSelection, context: { taskType?: TaskType }): string {
		return `${model.providerName}:${model.modelName}:${context.taskType || 'general'}`;
	}

	/**
	 * Explain routing decision
	 */
	private _explainDecision(best: { model: ModelSelection; finalScore: number; baseScore: number; learnedAdjustment: number }, scored: Array<{ model: ModelSelection; finalScore: number }>): string {
		const parts: string[] = [];

		if (best.learnedAdjustment > 10) {
			parts.push(`Learned preference (${best.learnedAdjustment.toFixed(0)} points)`);
		}

		parts.push(`Score: ${best.finalScore.toFixed(0)}`);

		if (scored.length > 1) {
			const margin = best.finalScore - scored[1].finalScore;
			if (margin > 20) {
				parts.push(`Clear winner (${margin.toFixed(0)} point margin)`);
			}
		}

		return parts.join(', ') || 'Selected based on capabilities and performance';
	}

	/**
	 * Estimate quality tier
	 */
	private _estimateQualityTier(score: number): 'cheap_fast' | 'standard' | 'escalate' | 'abstain' {
		if (score < 0) { return 'abstain'; }
		if (score < 30) { return 'cheap_fast'; }
		if (score < 70) { return 'standard'; }
		return 'escalate';
	}

	/**
	 * Get model timeout
	 */
	private _getModelTimeout(model: ModelSelection, context: TaskContext): number {
		// Simplified timeout logic
		const isLocal = (localProviderNames as readonly string[]).includes(model.providerName);
		const baseTimeout = isLocal ? 60_000 : 30_000; // 60s local, 30s cloud

		if (context.contextSize && context.contextSize > 50_000) {
			return baseTimeout * 2; // Double for large contexts
		}

		return baseTimeout;
	}

	/**
	 * Record routing decision for telemetry (non-blocking)
	 */
	private async _recordRoutingDecision(
		context: TaskContext,
		best: { model: ModelSelection; finalScore: number },
		scored: Array<{ model: ModelSelection; finalScore: number }>,
		eventId: string,
		startTime: number
	): Promise<void> {
		const routerTime = performance.now() - startTime;

		await this.telemetryService.recordRoutingDecision({
			taskType: context.taskType || 'general',
			contextSize: context.contextSize || 0,
			hasImages: context.hasImages || false,
			hasPDFs: context.hasPDFs || false,
			requiresReasoning: context.requiresComplexReasoning || false,
			selectedModel: {
				provider: best.model.providerName,
				modelName: best.model.modelName,
				isLocal: (localProviderNames as readonly string[]).includes(best.model.providerName)
			},
			routingScore: best.finalScore,
			routingConfidence: Math.min(1.0, best.finalScore / 100),
			routingReasoning: `Score: ${best.finalScore.toFixed(0)}`,
			fallbackChain: scored.slice(1, 4).map(s => ({
				provider: s.model.providerName,
				modelName: s.model.modelName
			})),
			cacheHit: false,
			localFirstMode: this.settingsService.state.globalSettings.localFirstAI ?? false,
			privacyMode: context.requiresPrivacy || false,
			warmupUsed: false, // Would need to track this
			firstTokenLatency: 0, // Will be updated later
			totalLatency: routerTime,
			tokensGenerated: 0, // Will be updated later
			tokensPerSecond: 0, // Will be updated later
			tokenCapsApplied: {
				featureCap: 0,
				actualTokensSent: 0,
				pruningUsed: false,
				truncationUsed: false,
				historyLimited: false
			},
			completed: false, // Will be updated later
			timedOut: false,
			partialResults: false
		});
	}
}

registerSingleton(IAdaptiveModelRouter, AdaptiveModelRouter, InstantiationType.Delayed);

