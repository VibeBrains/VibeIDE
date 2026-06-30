/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ModelSelection } from './vibeideSettingsTypes.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

/**
 * Routing outcome tracking for evaluation loop
 */
export interface RoutingOutcome {
	timestamp: number;
	modelSelection: ModelSelection;
	taskType: string;
	confidence: number;
	latencyMs?: number;
	success?: boolean; // true if user accepted/applied, false if rejected/undone
	escalated?: boolean; // true if escalated to another model
	timedOut?: boolean; // true if request timed out
	retryCount?: number; // number of retries
	userFeedback?: 'accept' | 'reject' | 'undo' | 'reask'; // explicit user feedback
}

/**
 * Routing quality metrics
 */
export interface RoutingQualityReport {
	totalRequests: number;
	winRate: number; // percentage of successful routings
	avgLatency: number; // average latency in ms
	escalationRate: number; // percentage of requests that escalated
	timeoutRate: number; // percentage of requests that timed out
	retryRate: number; // percentage of requests that retried
	modelPerformance: Map<string, {
		count: number;
		successRate: number;
		avgLatency: number;
	}>;
	recentChanges: RoutingOutcome[]; // last 20 outcomes
}

/**
 * Service for tracking routing outcomes and generating quality reports
 */
export class RoutingEvaluationService {
	private readonly storageKey = 'vibeide.routing.outcomes';
	private readonly maxStoredOutcomes = 1000; // Keep last 1000 outcomes
	private outcomes: RoutingOutcome[] = [];

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		this.loadOutcomes();
	}

	/**
	 * Record a routing outcome
	 */
	recordOutcome(outcome: RoutingOutcome): void {
		this.outcomes.push(outcome);

		// Keep only recent outcomes
		if (this.outcomes.length > this.maxStoredOutcomes) {
			this.outcomes = this.outcomes.slice(-this.maxStoredOutcomes);
		}

		// Persist to storage (async, don't block)
		this.saveOutcomes();
	}

	/**
	 * Update an existing outcome (e.g., when user accepts/rejects)
	 */
	updateOutcome(timestamp: number, updates: Partial<RoutingOutcome>): void {
		const index = this.outcomes.findIndex(o => o.timestamp === timestamp);
		if (index !== -1) {
			this.outcomes[index] = { ...this.outcomes[index], ...updates };
			this.saveOutcomes();
		}
	}

	/**
	 * Get quality report
	 */
	getQualityReport(): RoutingQualityReport {
		const recent = this.outcomes.slice(-100); // Last 100 outcomes for recent stats

		if (recent.length === 0) {
			return {
				totalRequests: 0,
				winRate: 0,
				avgLatency: 0,
				escalationRate: 0,
				timeoutRate: 0,
				retryRate: 0,
				modelPerformance: new Map(),
				recentChanges: [],
			};
		}

		const successful = recent.filter(o => o.success === true).length;
		const escalated = recent.filter(o => o.escalated === true).length;
		const timedOut = recent.filter(o => o.timedOut === true).length;
		const retried = recent.filter(o => (o.retryCount ?? 0) > 0).length;

		const latencies = recent.filter(o => o.latencyMs !== undefined).map(o => o.latencyMs!);
		const avgLatency = latencies.length > 0
			? latencies.reduce((a, b) => a + b, 0) / latencies.length
			: 0;

		// Model performance map
		const modelPerf = new Map<string, { count: number; successes: number; latencies: number[] }>();
		for (const outcome of recent) {
			const key = `${outcome.modelSelection.providerName}:${outcome.modelSelection.modelName}`;
			const existing = modelPerf.get(key) || { count: 0, successes: 0, latencies: [] as number[] };
			existing.count++;
			if (outcome.success === true) { existing.successes++; }
			if (outcome.latencyMs !== undefined) { existing.latencies.push(outcome.latencyMs); }
			modelPerf.set(key, existing);
		}

		// Convert to final format
		const modelPerformance = new Map<string, { count: number; successRate: number; avgLatency: number }>();
		for (const [key, data] of modelPerf.entries()) {
			modelPerformance.set(key, {
				count: data.count,
				successRate: data.count > 0 ? data.successes / data.count : 0,
				avgLatency: data.latencies.length > 0
					? data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length
					: 0,
			});
		}

		return {
			totalRequests: recent.length,
			winRate: successful / recent.length,
			avgLatency,
			escalationRate: escalated / recent.length,
			timeoutRate: timedOut / recent.length,
			retryRate: retried / recent.length,
			modelPerformance,
			recentChanges: this.outcomes.slice(-20), // Last 20 outcomes
		};
	}

	/**
	 * Get success rate for a specific model
	 */
	getModelSuccessRate(modelSelection: ModelSelection): number {
		const key = `${modelSelection.providerName}:${modelSelection.modelName}`;
		const recent = this.outcomes.slice(-100);
		const modelOutcomes = recent.filter(o =>
			`${o.modelSelection.providerName}:${o.modelSelection.modelName}` === key
		);

		if (modelOutcomes.length === 0) { return 0.5; } // Default to neutral if no data

		const successful = modelOutcomes.filter(o => o.success === true).length;
		return successful / modelOutcomes.length;
	}

	private loadOutcomes(): void {
		try {
			const stored = this.storageService.get(this.storageKey, StorageScope.APPLICATION);
			if (stored) {
				this.outcomes = JSON.parse(stored);
			}
		} catch (e) {
			// Ignore parse errors
			this.outcomes = [];
		}
	}

	private saveOutcomes(): void {
		try {
			const data = JSON.stringify(this.outcomes);
			this.storageService.store(this.storageKey, data, StorageScope.APPLICATION, StorageTarget.MACHINE);
		} catch (e) {
			// Ignore storage errors
		}
	}
}

