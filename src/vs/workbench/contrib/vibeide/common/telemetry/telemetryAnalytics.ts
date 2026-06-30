/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../../nls.js';
import { IVibeideTelemetryService } from './telemetryService.js';
import { RoutingDecisionEvent, ModelRanking, RoutingPattern, TaskType } from './telemetryTypes.js';

/**
 * Analytics service for computing insights from telemetry data
 */
export class TelemetryAnalyticsService {
	constructor(private readonly telemetryService: IVibeideTelemetryService) { }

	/**
	 * Compute model rankings by composite score: (speed × quality) / cost
	 * Used by adaptive routing
	 */
	async computeModelRankings(taskType: TaskType): Promise<ModelRanking[]> {
		const events = await this.telemetryService.queryEvents({
			eventType: 'routing',
			taskType,
			timeRange: {
				start: Date.now() - (7 * 24 * 60 * 60 * 1000), // Last 7 days
				end: Date.now()
			}
		});

		const routingEvents = events.filter(e => e.type === 'routing') as RoutingDecisionEvent[];

		// Group by model
		const groups = new Map<string, RoutingDecisionEvent[]>();
		for (const event of routingEvents) {
			const key = `${event.selectedModel.provider}:${event.selectedModel.modelName}`;
			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key)!.push(event);
		}

		// Compute metrics for each model
		const rankings: ModelRanking[] = [];
		for (const [key, groupEvents] of groups) {
			const [provider, modelName] = key.split(':');
			const isLocal = groupEvents[0].selectedModel.isLocal || false;

			const speedScore = this._computeSpeedScore(groupEvents);
			const qualityScore = this._computeQualityScore(groupEvents);
			const costScore = this._computeCostScore(groupEvents, isLocal);
			const compositeScore = this._computeCompositeScore(speedScore, qualityScore, costScore);

			rankings.push({
				model: {
					providerName: provider as import('../vibeideSettingsTypes.js').ProviderName,
					modelName
				},
				taskType,
				speedScore,
				qualityScore,
				costScore,
				compositeScore,
				sampleSize: groupEvents.length
			});
		}

		// Sort by composite score (highest first)
		return rankings.sort((a, b) => b.compositeScore - a.compositeScore);
	}

	/**
	 * Compute speed score (0-1, higher is faster)
	 */
	private _computeSpeedScore(events: RoutingDecisionEvent[]): number {
		if (events.length === 0) { return 0; }

		const latencies = events
			.filter(e => e.totalLatency > 0)
			.map(e => e.totalLatency);

		if (latencies.length === 0) { return 0.5; } // Neutral if no data

		const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
		const tokensPerSecond = events
			.filter(e => e.tokensPerSecond > 0)
			.map(e => e.tokensPerSecond);

		if (tokensPerSecond.length === 0) {
			// Score based on latency only (inverse, normalized)
			// Assume 10s is "slow", 1s is "fast"
			return Math.max(0, Math.min(1, 1 - (avgLatency - 1000) / 9000));
		}

		const avgTokensPerSecond = tokensPerSecond.reduce((a, b) => a + b, 0) / tokensPerSecond.length;

		// Combine latency and throughput
		// Normalize: assume 50 tokens/s is good, 10 tokens/s is slow
		const throughputScore = Math.min(1, avgTokensPerSecond / 50);
		const latencyScore = Math.max(0, Math.min(1, 1 - (avgLatency - 1000) / 9000));

		return (throughputScore * 0.6) + (latencyScore * 0.4);
	}

	/**
	 * Compute quality score (0-1, higher is better)
	 * Quality = acceptance rate + (1 - normalized edit distance)
	 */
	private _computeQualityScore(events: RoutingDecisionEvent[]): number {
		if (events.length === 0) { return 0; }

		const eventsWithOutcome = events.filter(e => e.userAccepted !== undefined);
		if (eventsWithOutcome.length === 0) { return 0.5; } // Neutral if no outcome data

		const acceptanceRate = eventsWithOutcome.filter(e => e.userAccepted === true).length / eventsWithOutcome.length;

		const eventsWithEditDistance = events.filter(e => e.editDistance !== undefined);
		let normalizedEditDistance = 0;
		if (eventsWithEditDistance.length > 0) {
			const avgEditDistance = eventsWithEditDistance.reduce((sum, e) => sum + (e.editDistance || 0), 0) / eventsWithEditDistance.length;
			normalizedEditDistance = Math.min(avgEditDistance / 100, 1); // Normalize to 0-1
		}

		// Quality = 70% acceptance rate + 30% (1 - edit distance)
		return (acceptanceRate * 0.7) + ((1 - normalizedEditDistance) * 0.3);
	}

	/**
	 * Compute cost score (0-1, higher is cheaper)
	 */
	private _computeCostScore(events: RoutingDecisionEvent[], isLocal: boolean): number {
		// Local models are free (score = 1)
		if (isLocal) { return 1.0; }

		// For cloud models, we'd need cost data
		// For now, assume all cloud models have similar cost (score = 0.5)
		// TODO: Integrate actual cost data from model capabilities
		return 0.5;
	}

	/**
	 * Compute composite score: (speed × quality) / cost
	 * Higher is better
	 */
	private _computeCompositeScore(speedScore: number, qualityScore: number, costScore: number): number {
		// Composite = (speed × quality) / (1 - costScore + 0.1)
		// This rewards fast, high-quality, cheap models
		const costPenalty = 1 - costScore + 0.1; // Avoid division by zero
		return (speedScore * qualityScore) / costPenalty;
	}

	/**
	 * Detect routing patterns from telemetry
	 */
	async detectRoutingPatterns(): Promise<RoutingPattern[]> {
		const events = await this.telemetryService.queryEvents({
			eventType: 'routing',
			timeRange: {
				start: Date.now() - (30 * 24 * 60 * 60 * 1000), // Last 30 days
				end: Date.now()
			}
		});

		const routingEvents = events.filter(e => e.type === 'routing') as RoutingDecisionEvent[];
		const patterns: RoutingPattern[] = [];

		// Pattern 1: Local models rejection rate for vision tasks
		const visionEvents = routingEvents.filter(e => e.taskType === 'vision' || e.hasImages);
		const localVisionEvents = visionEvents.filter(e => e.selectedModel.isLocal);
		if (localVisionEvents.length > 10) {
			const rejectionRate = localVisionEvents.filter(e => e.userRejected === true || e.userAccepted === false).length / localVisionEvents.length;
			if (rejectionRate > 0.5) {
				patterns.push({
					pattern: 'local_vision_rejection',
					description: localize('vibeide.telemetry.pattern.localVisionRejection', "Локальные модели отклоняются в {0}% случаев при задачах с изображениями", (rejectionRate * 100).toFixed(0)),
					confidence: Math.min(1, localVisionEvents.length / 50),
					recommendation: 'Consider routing vision tasks to cloud models by default'
				});
			}
		}

		// Pattern 2: Speculative escalation effectiveness
		const escalationEvents = routingEvents.filter(e => e.speculativeEscalation?.used === true);
		if (escalationEvents.length > 10) {
			const falsePositives = escalationEvents.filter(e =>
				e.speculativeEscalation?.escalatedTo && e.userAccepted === false
			).length;
			const truePositives = escalationEvents.filter(e =>
				e.speculativeEscalation?.escalatedTo && e.userAccepted === true
			).length;
			const precision = (truePositives + falsePositives) > 0
				? truePositives / (truePositives + falsePositives)
				: 0;

			patterns.push({
				pattern: 'speculative_escalation',
				description: localize('vibeide.telemetry.pattern.speculativeEscalation', "Точность спекулятивной эскалации: {0}%", (precision * 100).toFixed(0)),
				confidence: Math.min(1, escalationEvents.length / 50),
				recommendation: precision < 0.6
					? 'Consider disabling speculative escalation (low precision)'
					: 'Speculative escalation is effective'
			});
		}

		// Pattern 3: Model performance by task type
		for (const taskType of ['chat', 'code', 'vision'] as TaskType[]) {
			const taskEvents = routingEvents.filter(e => e.taskType === taskType);
			if (taskEvents.length > 20) {
				const modelGroups = new Map<string, RoutingDecisionEvent[]>();
				for (const event of taskEvents) {
					const key = `${event.selectedModel.provider}:${event.selectedModel.modelName}`;
					if (!modelGroups.has(key)) {
						modelGroups.set(key, []);
					}
					modelGroups.get(key)!.push(event);
				}

				// Find best performing model
				let bestModel = '';
				let bestScore = 0;
				for (const [model, events] of modelGroups) {
					const qualityScore = this._computeQualityScore(events);
					if (qualityScore > bestScore) {
						bestScore = qualityScore;
						bestModel = model;
					}
				}

				if (bestModel && bestScore > 0.7) {
					patterns.push({
						pattern: `best_model_${taskType}`,
						description: localize('vibeide.telemetry.pattern.bestModel', "{0} показывает лучший результат для задач типа {1} (качество: {2}%)", bestModel, taskType, (bestScore * 100).toFixed(0)),
						confidence: Math.min(1, taskEvents.length / 100),
						recommendation: `Prefer ${bestModel} for ${taskType} tasks`
					});
				}
			}
		}

		return patterns;
	}

	/**
	 * Suggest routing optimizations based on data
	 */
	async suggestOptimizations(): Promise<string[]> {
		const patterns = await this.detectRoutingPatterns();
		const suggestions: string[] = [];

		for (const pattern of patterns) {
			if (pattern.recommendation) {
				suggestions.push(pattern.recommendation);
			}
		}

		// Additional suggestions based on rankings
		const taskTypes: TaskType[] = ['chat', 'code', 'vision'];
		for (const taskType of taskTypes) {
			const rankings = await this.computeModelRankings(taskType);
			if (rankings.length > 0 && rankings[0].sampleSize > 20) {
				const topModel = rankings[0];
				if (topModel.compositeScore > 0.8) {
					suggestions.push(
						`Increase preference for ${topModel.model.providerName}/${topModel.model.modelName} for ${taskType} tasks (composite score: ${(topModel.compositeScore * 100).toFixed(0)}%)`
					);
				}
			}
		}

		return suggestions;
	}
}

