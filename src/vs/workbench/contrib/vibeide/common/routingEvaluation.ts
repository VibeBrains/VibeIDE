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
	/**
	 * Key the verdict of the turn finds this outcome by
	 * Absent in records written before verdicts existed: those stay unrated forever
	 */
	id?: string;
	timestamp: number;
	modelSelection: ModelSelection;
	taskType: string;
	confidence: number;
	latencyMs?: number;
	/**
	 * Verdict of the turn: true when the model answered, false when it failed and «Авто» moved on
	 * Absent until the turn settles — an unrated outcome says nothing about the model
	 */
	success?: boolean;
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
	winRate: number; // share of successful routings among rated ones
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

/** How many recent rated outcomes of a model its success rate is computed over */
const SUCCESS_RATE_WINDOW = 100;

/** Success rate of a model nobody has rated yet: neither rewards nor punishes it */
const NEUTRAL_SUCCESS_RATE = 0.5;

/**
 * Weight of the neutral prior in pseudo-outcomes
 * A Bayesian average: one failure moves a fresh model from 0.5 to 0.4, not to 0,
 * And the prior fades as real verdicts accumulate
 */
const SUCCESS_PRIOR_WEIGHT = 4;

/** What the turn tells about the model the router chose */
export interface RoutingVerdict {
	readonly success: boolean;
	readonly escalated?: boolean;
	readonly timedOut?: boolean;
}

function modelKeyOf(modelSelection: ModelSelection): string {
	return `${modelSelection.providerName}:${modelSelection.modelName}`;
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
	 * Settle the outcome recorded under this id with the verdict of its turn
	 * The first verdict wins: a later one for the same turn would rate the fallback model under the routed one
	 */
	updateOutcome(id: string, verdict: RoutingVerdict): void {
		const index = this.outcomes.findIndex(o => o.id === id);
		if (index === -1 || this.outcomes[index].success !== undefined) {
			return;
		}
		this.outcomes[index] = { ...this.outcomes[index], ...verdict };
		this.saveOutcomes();
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

		const rated = recent.filter(o => o.success !== undefined);
		const successful = rated.filter(o => o.success === true).length;
		const escalated = recent.filter(o => o.escalated === true).length;
		const timedOut = recent.filter(o => o.timedOut === true).length;
		const retried = recent.filter(o => (o.retryCount ?? 0) > 0).length;

		const latencies = recent.filter(o => o.latencyMs !== undefined).map(o => o.latencyMs!);
		const avgLatency = latencies.length > 0
			? latencies.reduce((a, b) => a + b, 0) / latencies.length
			: 0;

		// Model performance map
		const modelPerf = new Map<string, { count: number; rated: number; successes: number; latencies: number[] }>();
		for (const outcome of recent) {
			const key = modelKeyOf(outcome.modelSelection);
			const existing = modelPerf.get(key) || { count: 0, rated: 0, successes: 0, latencies: [] as number[] };
			existing.count++;
			if (outcome.success !== undefined) { existing.rated++; }
			if (outcome.success === true) { existing.successes++; }
			if (outcome.latencyMs !== undefined) { existing.latencies.push(outcome.latencyMs); }
			modelPerf.set(key, existing);
		}

		// Convert to final format
		const modelPerformance = new Map<string, { count: number; successRate: number; avgLatency: number }>();
		for (const [key, data] of modelPerf.entries()) {
			modelPerformance.set(key, {
				count: data.count,
				successRate: data.rated > 0 ? data.successes / data.rated : 0,
				avgLatency: data.latencies.length > 0
					? data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length
					: 0,
			});
		}

		return {
			totalRequests: recent.length,
			winRate: rated.length > 0 ? successful / rated.length : 0,
			avgLatency,
			escalationRate: escalated / recent.length,
			timeoutRate: timedOut / recent.length,
			retryRate: retried / recent.length,
			modelPerformance,
			recentChanges: this.outcomes.slice(-20), // Last 20 outcomes
		};
	}

	/**
	 * Success rate of a model over its recent rated outcomes, pulled toward neutral by a prior
	 * Unrated outcomes do not count: a decision whose turn never reported back is not a failure
	 */
	getModelSuccessRate(modelSelection: ModelSelection): number {
		const key = modelKeyOf(modelSelection);
		const rated = this.outcomes
			.filter(o => o.success !== undefined && modelKeyOf(o.modelSelection) === key)
			.slice(-SUCCESS_RATE_WINDOW);
		const successes = rated.filter(o => o.success === true).length;
		return (successes + NEUTRAL_SUCCESS_RATE * SUCCESS_PRIOR_WEIGHT) / (rated.length + SUCCESS_PRIOR_WEIGHT);
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

