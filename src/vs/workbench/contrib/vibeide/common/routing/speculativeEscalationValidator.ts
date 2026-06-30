/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IVibeideTelemetryService } from '../telemetry/telemetryService.js';
import { RoutingDecisionEvent } from '../telemetry/telemetryTypes.js';

export interface EscalationAnalysis {
	metrics: {
		totalEscalations: number;
		falsePositives: number;
		truePositives: number;
		avgLatencyOverhead: number;
		qualityImprovement: number;
	};
	recommendation: 'Keep speculative escalation' | 'Disable speculative escalation (not effective)';
	precision: number;
	worthwhile: boolean;
}

/**
 * Validator for speculative escalation effectiveness
 * Tracks speculative escalation effectiveness and recommends enable/disable
 */
export class SpeculativeEscalationValidator {
	constructor(private readonly telemetryService: IVibeideTelemetryService) { }

	/**
	 * Analyze speculative escalation effectiveness
	 */
	async analyze(): Promise<EscalationAnalysis> {
		const events = await this.telemetryService.queryEvents({
			eventType: 'routing',
			timeRange: {
				start: Date.now() - (30 * 24 * 60 * 60 * 1000), // Last 30 days
				end: Date.now()
			}
		});

		const routingEvents = events.filter(e => e.type === 'routing') as RoutingDecisionEvent[];
		const escalationEvents = routingEvents.filter(e => e.speculativeEscalation?.used === true);

		if (escalationEvents.length === 0) {
			return {
				metrics: {
					totalEscalations: 0,
					falsePositives: 0,
					truePositives: 0,
					avgLatencyOverhead: 0,
					qualityImprovement: 0
				},
				recommendation: 'Keep speculative escalation', // No data, keep default
				precision: 0,
				worthwhile: true
			};
		}

		// Find events that actually escalated
		const escalatedEvents = escalationEvents.filter(e =>
			e.speculativeEscalation?.escalatedTo !== undefined
		);

		// False positives: escalated but user rejected
		const falsePositives = escalatedEvents.filter(e =>
			e.userRejected === true || e.userAccepted === false
		).length;

		// True positives: escalated and user accepted
		const truePositives = escalatedEvents.filter(e =>
			e.userAccepted === true
		).length;

		// Compute precision
		const precision = (truePositives + falsePositives) > 0
			? truePositives / (truePositives + falsePositives)
			: 0;

		// Compute latency overhead (compare escalated vs non-escalated)
		const avgLatencyOverhead = this._computeAvgLatencyOverhead(escalationEvents, routingEvents);

		// Compute quality improvement (acceptance rate difference)
		const qualityImprovement = this._computeQualityImprovement(escalationEvents, routingEvents);

		// Determine if worthwhile
		const worthwhile = qualityImprovement > avgLatencyOverhead && precision > 0.6;

		return {
			metrics: {
				totalEscalations: escalationEvents.length,
				falsePositives,
				truePositives,
				avgLatencyOverhead,
				qualityImprovement
			},
			recommendation: worthwhile && precision > 0.6
				? 'Keep speculative escalation'
				: 'Disable speculative escalation (not effective)',
			precision,
			worthwhile
		};
	}

	/**
	 * Compute average latency overhead from speculative escalation
	 */
	private _computeAvgLatencyOverhead(
		escalationEvents: RoutingDecisionEvent[],
		allEvents: RoutingDecisionEvent[]
	): number {
		if (escalationEvents.length === 0) { return 0; }

		// Compare escalated events to similar non-escalated events
		const escalatedLatencies = escalationEvents
			.filter(e => e.totalLatency > 0)
			.map(e => e.totalLatency);

		if (escalatedLatencies.length === 0) { return 0; }

		const avgEscalatedLatency = escalatedLatencies.reduce((a, b) => a + b, 0) / escalatedLatencies.length;

		// Find similar non-escalated events (same task type, similar context size)
		const nonEscalatedEvents = allEvents.filter(e =>
			!e.speculativeEscalation?.used &&
			e.totalLatency > 0
		);

		if (nonEscalatedEvents.length === 0) { return 0; }

		const avgNonEscalatedLatency = nonEscalatedEvents
			.map(e => e.totalLatency)
			.reduce((a, b) => a + b, 0) / nonEscalatedEvents.length;

		return Math.max(0, avgEscalatedLatency - avgNonEscalatedLatency);
	}

	/**
	 * Compute quality improvement from speculative escalation
	 */
	private _computeQualityImprovement(
		escalationEvents: RoutingDecisionEvent[],
		allEvents: RoutingDecisionEvent[]
	): number {
		if (escalationEvents.length === 0) { return 0; }

		// Acceptance rate for escalated events
		const escalatedAccepted = escalationEvents.filter(e => e.userAccepted === true).length;
		const escalatedAcceptanceRate = escalationEvents.length > 0
			? escalatedAccepted / escalationEvents.length
			: 0;

		// Acceptance rate for non-escalated events (similar context)
		const nonEscalatedEvents = allEvents.filter(e => !e.speculativeEscalation?.used);
		const nonEscalatedAccepted = nonEscalatedEvents.filter(e => e.userAccepted === true).length;
		const nonEscalatedAcceptanceRate = nonEscalatedEvents.length > 0
			? nonEscalatedAccepted / nonEscalatedEvents.length
			: 0;

		// Improvement as percentage point difference
		return (escalatedAcceptanceRate - nonEscalatedAcceptanceRate) * 100;
	}
}

