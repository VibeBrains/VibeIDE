/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Scope contract: references/v1/telemetry-service-scope.md
// Local audit channel — no outbound calls.  Rename to RoutingAuditService is a backlog item.
import { vibeLog } from '../vibeLog.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { TelemetryEvent, RoutingDecisionEvent, ModelPerformanceEvent, OptimizationImpactEvent, TelemetryQuery } from './telemetryTypes.js';
import { TelemetryStorageService } from './telemetryStorage.js';
import { generateUuid } from '../../../../../base/common/uuid.js';

export const IVibeideTelemetryService = createDecorator<IVibeideTelemetryService>('VibeideTelemetryService');

export interface IVibeideTelemetryService {
	readonly _serviceBrand: undefined;
	recordRoutingDecision(event: Omit<RoutingDecisionEvent, 'type' | 'timestamp' | 'eventId'>): Promise<void>;
	updateRoutingOutcome(eventId: string, outcome: {
		userAccepted?: boolean;
		userModified?: boolean;
		editDistance?: number;
		userRejected?: boolean;
		userRating?: number;
	}): Promise<void>;
	getModelPerformanceMetrics(filters?: {
		taskType?: string;
		provider?: string;
		isLocal?: boolean;
		timeRange?: { start: number; end: number };
	}): Promise<ModelPerformanceEvent[]>;
	getOptimizationImpact(): Promise<OptimizationImpactEvent[]>;
	queryEvents(query: TelemetryQuery): Promise<TelemetryEvent[]>;
}

/**
 * Telemetry service for tracking AI interactions.
 * CRITICAL: All telemetry operations must be async and non-blocking.
 * User experience should NEVER be impacted by telemetry.
 *
 * Scope contract: see `references/v1/telemetry-service-scope.md`. This is a
 * **local audit channel** for routing decisions and model performance — zero
 * outbound calls. The class name "Telemetry" is misleading and queued for
 * rename to `RoutingAuditService`; the no-cloud-telemetry policy in
 * `references/v1/telemetry-policy.md` applies.
 */
export class VibeideTelemetryService extends Disposable implements IVibeideTelemetryService {
	readonly _serviceBrand: undefined;

	private eventQueue: TelemetryEvent[] = [];
	private readonly maxQueueSize = 1000;
	private readonly flushInterval = 30_000; // Flush every 30 seconds
	private flushTimer: ReturnType<typeof setInterval> | null = null;
	private pendingEventIds: Map<string, RoutingDecisionEvent> = new Map();
	private storageService: TelemetryStorageService;

	constructor() {
		super();
		this.storageService = new TelemetryStorageService();
		this._startFlushTimer();
		this._register({
			dispose: () => {
				if (this.flushTimer) {
					clearInterval(this.flushTimer);
				}
				// Flush remaining events on dispose
				this._flushAsync().catch(err => {
					vibeLog.warn('telemetry', '[Telemetry] Failed to flush on dispose:', err);
				});
			}
		});
	}

	/**
	 * Record a routing decision (non-blocking)
	 */
	async recordRoutingDecision(event: Omit<RoutingDecisionEvent, 'type' | 'timestamp' | 'eventId'>): Promise<void> {
		const telemetryEvent: RoutingDecisionEvent = {
			type: 'routing',
			timestamp: Date.now(),
			eventId: generateUuid(),
			...event
		};

		// Store in pending map for outcome updates
		this.pendingEventIds.set(telemetryEvent.eventId, telemetryEvent);

		// Queue event (non-blocking)
		this.eventQueue.push(telemetryEvent);

		// Async flush if queue is full
		if (this.eventQueue.length >= this.maxQueueSize) {
			this._flushAsync().catch(err => {
				vibeLog.warn('telemetry', '[Telemetry] Failed to flush queue:', err);
			});
		}
	}

	/**
	 * Update routing outcome with user feedback
	 * Called AFTER the user interacts with the result
	 */
	async updateRoutingOutcome(
		eventId: string,
		outcome: {
			userAccepted?: boolean;
			userModified?: boolean;
			editDistance?: number;
			userRejected?: boolean;
			userRating?: number;
		}
	): Promise<void> {
		const event = this.pendingEventIds.get(eventId);
		if (!event) {
			// Event might have been flushed, try to find in queue
			const queuedEvent = this.eventQueue.find(e => e.eventId === eventId) as RoutingDecisionEvent | undefined;
			if (queuedEvent) {
				Object.assign(queuedEvent, outcome);
			}
			return;
		}

		// Update event with outcome
		Object.assign(event, outcome);

		// Re-queue updated event (will replace old one on flush)
		const index = this.eventQueue.findIndex(e => e.eventId === eventId);
		if (index >= 0) {
			this.eventQueue[index] = event;
		} else {
			this.eventQueue.push(event);
		}
	}

	/**
	 * Get model performance metrics (aggregate)
	 */
	async getModelPerformanceMetrics(filters?: {
		taskType?: import('./telemetryTypes.js').TaskType;
		provider?: string;
		isLocal?: boolean;
		timeRange?: { start: number; end: number };
	}): Promise<ModelPerformanceEvent[]> {
		const query: TelemetryQuery = {
			eventType: 'routing',
			taskType: filters?.taskType,
			provider: filters?.provider,
			isLocal: filters?.isLocal,
			timeRange: filters?.timeRange
		};

		const events = await this.storageService.queryEvents(query);
		const routingEvents = events.filter(e => e.type === 'routing') as RoutingDecisionEvent[];

		// Group by model and task type
		const groups = new Map<string, RoutingDecisionEvent[]>();
		for (const event of routingEvents) {
			const key = `${event.selectedModel.provider}:${event.selectedModel.modelName}:${event.taskType}`;
			if (!groups.has(key)) {
				groups.set(key, []);
			}
			groups.get(key)!.push(event);
		}

		// Compute aggregate metrics
		const performanceEvents: ModelPerformanceEvent[] = [];
		for (const [key, groupEvents] of groups) {
			const [provider, modelName] = key.split(':');
			const taskType = groupEvents[0].taskType;
			const isLocal = groupEvents[0].selectedModel.isLocal;

			const totalRequests = groupEvents.length;
			const successful = groupEvents.filter(e => e.completed && !e.error).length;
			const successRate = totalRequests > 0 ? successful / totalRequests : 0;

			const latencies = groupEvents.map(e => e.totalLatency).filter(l => l > 0);
			const avgLatency = latencies.length > 0
				? latencies.reduce((a, b) => a + b, 0) / latencies.length
				: 0;

			const firstTokenLatencies = groupEvents.map(e => e.firstTokenLatency).filter(l => l > 0);
			const avgFirstTokenLatency = firstTokenLatencies.length > 0
				? firstTokenLatencies.reduce((a, b) => a + b, 0) / firstTokenLatencies.length
				: 0;

			const tokensPerSecond = groupEvents.map(e => e.tokensPerSecond).filter(t => t > 0);
			const avgTokensPerSecond = tokensPerSecond.length > 0
				? tokensPerSecond.reduce((a, b) => a + b, 0) / tokensPerSecond.length
				: 0;

			const accepted = groupEvents.filter(e => e.userAccepted === true).length;
			const avgAcceptanceRate = totalRequests > 0 ? accepted / totalRequests : 0;

			// Compute quality score
			const qualityScores = groupEvents
				.filter(e => e.userAccepted !== undefined)
				.map(e => {
					if (!e.userAccepted) { return 0; }
					if (e.editDistance !== undefined) {
						return Math.max(0, 1 - (e.editDistance / 100)); // Normalize edit distance
					}
					return 1;
				});
			const avgQualityScore = qualityScores.length > 0
				? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
				: 0;

			// Time range
			const timestamps = groupEvents.map(e => e.timestamp);
			const timeRange = {
				start: Math.min(...timestamps),
				end: Math.max(...timestamps)
			};

			performanceEvents.push({
				type: 'model_performance',
				timestamp: Date.now(),
				eventId: generateUuid(),
				provider,
				modelName,
				isLocal,
				taskType,
				totalRequests,
				successRate,
				avgLatency,
				avgFirstTokenLatency,
				avgTokensPerSecond,
				avgAcceptanceRate,
				avgQualityScore,
				timeRange
			});
		}

		return performanceEvents;
	}

	/**
	 * Get optimization impact metrics
	 */
	async getOptimizationImpact(): Promise<OptimizationImpactEvent[]> {
		// This would be computed from comparing events with/without optimizations
		// For now, return empty array - can be implemented later
		return [];
	}

	/**
	 * Query events directly
	 */
	async queryEvents(query: TelemetryQuery): Promise<TelemetryEvent[]> {
		return this.storageService.queryEvents(query);
	}

	/**
	 * Start periodic flush timer
	 */
	private _startFlushTimer(): void {
		this.flushTimer = setInterval(() => {
			this._flushAsync().catch(err => {
				vibeLog.warn('telemetry', '[Telemetry] Failed to flush:', err);
			});
		}, this.flushInterval);
	}

	/**
	 * Flush events to storage (async, non-blocking)
	 */
	private async _flushAsync(): Promise<void> {
		if (this.eventQueue.length === 0) { return; }

		const eventsToFlush = [...this.eventQueue];
		this.eventQueue = [];

		try {
			await this.storageService.writeEvents(eventsToFlush);
		} catch (error) {
			// Re-queue events on failure
			this.eventQueue.unshift(...eventsToFlush);
			throw error;
		}
	}
}

registerSingleton(IVibeideTelemetryService, VibeideTelemetryService, InstantiationType.Delayed);

