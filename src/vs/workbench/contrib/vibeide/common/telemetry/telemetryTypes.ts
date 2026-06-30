/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Types imported from other modules

// Re-export TaskType for use in telemetry
export type TaskType = 'chat' | 'code' | 'vision' | 'pdf' | 'web_search' | 'eval' | 'general';

/**
 * Core telemetry event types
 */
export type TelemetryEventType = 'routing' | 'model_performance' | 'optimization_impact';

/**
 * Base telemetry event
 */
export interface TelemetryEvent {
	type: TelemetryEventType;
	timestamp: number;
	eventId: string;
}

/**
 * Routing decision event - tracks every routing decision and its outcome
 */
export interface RoutingDecisionEvent extends TelemetryEvent {
	type: 'routing';

	// Task context
	taskType: TaskType;
	contextSize: number; // tokens in context
	hasImages: boolean;
	hasPDFs: boolean;
	requiresReasoning: boolean;

	// Routing decision
	selectedModel: {
		provider: string;
		modelName: string;
		isLocal: boolean;
	};
	routingScore: number;
	routingConfidence: number;
	routingReasoning: string;
	fallbackChain: Array<{ provider: string; modelName: string }>;
	cacheHit: boolean;
	localFirstMode: boolean;
	privacyMode: boolean;

	// Speculative escalation (if used)
	speculativeEscalation?: {
		used: boolean;
		fastModelUsed?: string;
		escalatedTo?: string;
		escalationReason?: string;
		escalatedAtTokenCount?: number;
	};

	// Performance metrics
	warmupUsed: boolean;
	warmupLatency?: number;
	firstTokenLatency: number; // TTFT
	totalLatency: number;
	tokensGenerated: number;
	tokensPerSecond: number;

	// Quality signals (collected after response)
	userAccepted?: boolean; // Did user accept the suggestion?
	userModified?: boolean; // Did user edit the AI output?
	editDistance?: number; // Levenshtein distance of user edits
	userRejected?: boolean; // Did user explicitly reject (e.g., undo)?
	userRating?: number; // Optional explicit rating (1-5)

	// Optimization details
	tokenCapsApplied: {
		featureCap: number;
		actualTokensSent: number;
		pruningUsed: boolean;
		truncationUsed: boolean;
		historyLimited: boolean;
	};

	// Outcome
	completed: boolean;
	timedOut: boolean;
	partialResults: boolean;
	error?: string;
}

/**
 * Model performance event - aggregate metrics computed periodically
 */
export interface ModelPerformanceEvent extends TelemetryEvent {
	type: 'model_performance';
	provider: string;
	modelName: string;
	isLocal: boolean;
	taskType: TaskType;

	// Aggregate metrics (computed periodically)
	totalRequests: number;
	successRate: number;
	avgLatency: number;
	avgFirstTokenLatency: number;
	avgTokensPerSecond: number;
	avgAcceptanceRate: number; // % of responses accepted by user
	avgQualityScore: number; // Computed from acceptance + edit distance

	// Cost (for cloud models)
	totalCost?: number;
	costPerRequest?: number;

	// Time range for this aggregation
	timeRange: {
		start: number;
		end: number;
	};
}

/**
 * Optimization impact event - tracks effectiveness of optimizations
 */
export interface OptimizationImpactEvent extends TelemetryEvent {
	type: 'optimization_impact';
	optimizationType: 'warmup' | 'pruning' | 'truncation' | 'caching' | 'historyLimiting' | 'compression';
	latencyBefore: number;
	latencyAfter: number;
	improvement: number; // percentage
	tradeoff?: {
		qualityImpact?: number; // change in acceptance rate
		contextLost?: number; // tokens removed
	};
}

/**
 * Discriminated union of all concrete telemetry events. Persisted events are
 * read back as one of these variants; narrow on `type` to access variant fields.
 */
export type AnyTelemetryEvent = RoutingDecisionEvent | ModelPerformanceEvent | OptimizationImpactEvent;

/**
 * Query interface for telemetry storage
 */
export interface TelemetryQuery {
	eventType?: TelemetryEventType;
	taskType?: TaskType;
	provider?: string;
	modelName?: string;
	isLocal?: boolean;
	timeRange?: {
		start: number;
		end: number;
	};
	limit?: number;
}

/**
 * Model ranking result from analytics
 */
export interface ModelRanking {
	model: import('../vibeideSettingsTypes.js').ModelSelection & { isLocal?: boolean };
	taskType: TaskType;
	speedScore: number;
	qualityScore: number;
	costScore: number;
	compositeScore: number;
	sampleSize: number;
}

/**
 * Routing pattern detection result
 */
export interface RoutingPattern {
	pattern: string;
	description: string;
	confidence: number;
	recommendation?: string;
}

