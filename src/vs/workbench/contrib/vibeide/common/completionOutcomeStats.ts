/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Completion outcome aggregator (1024) — pure helper.
 *
 * Local-only telemetry: every FIM completion outcome (accept / reject /
 * ignore) is recorded into an event list; this aggregator turns that list
 * into per-model leaderboard rows for `vibe doctor` and the Settings UI.
 *
 * Per Phase 1 / AGENTS.md: NO cloud telemetry. The events live in IDE
 * storage and are exported via `vibe doctor --completion-stats`. This
 * module is only the math; storage + export hooks are the wrapper layer.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type CompletionOutcome = 'accept' | 'reject' | 'ignore';

export interface CompletionEvent {
	timestamp: number;
	modelId: string;
	outcome: CompletionOutcome;
	/** Number of characters in the served suggestion. */
	suggestionLength: number;
	/** Optional: number of characters actually accepted (for partial Tab). */
	acceptedLength?: number;
	/** Optional: server-side latency reported by provider. */
	latencyMs?: number;
}

export interface ModelLeaderboardRow {
	modelId: string;
	totalEvents: number;
	accepts: number;
	rejects: number;
	ignores: number;
	acceptRate: number;
	rejectRate: number;
	avgSuggestionLength: number;
	avgLatencyMs: number | null;
	/** Sum of accepted characters / sum of suggested characters when there were any accepts. */
	keepRate: number | null;
}

export interface LeaderboardSummary {
	periodStart: number;
	periodEnd: number;
	totalEvents: number;
	overallAcceptRate: number;
	rows: ReadonlyArray<ModelLeaderboardRow>;
}

/**
 * Build the leaderboard for `[periodStart, periodEnd]` (inclusive). Pure.
 *
 * Out-of-range and malformed events are silently dropped. Stable ordering:
 * acceptRate descending, then totalEvents descending (more data wins ties),
 * then modelId ascending.
 *
 * `keepRate = sum(acceptedLength) / sum(suggestionLength)` — measures how
 * much of the suggestion the user actually kept on average. Null when no
 * accepted events recorded `acceptedLength`.
 */
export function aggregateCompletionEvents(
	events: ReadonlyArray<CompletionEvent>,
	periodStart: number,
	periodEnd: number,
): LeaderboardSummary {
	const buckets = new Map<string, {
		totalEvents: number;
		accepts: number;
		rejects: number;
		ignores: number;
		suggestionLengthSum: number;
		latencySum: number;
		latencyCount: number;
		acceptedLengthSum: number;
		acceptedLengthCount: number;
		acceptedSuggestionLengthSum: number;
	}>();

	let totalInPeriod = 0;
	let acceptsInPeriod = 0;

	for (const event of events) {
		if (!isValid(event)) { continue; }
		if (event.timestamp < periodStart || event.timestamp > periodEnd) { continue; }
		totalInPeriod++;
		if (event.outcome === 'accept') { acceptsInPeriod++; }

		const b = buckets.get(event.modelId) ?? {
			totalEvents: 0, accepts: 0, rejects: 0, ignores: 0,
			suggestionLengthSum: 0,
			latencySum: 0, latencyCount: 0,
			acceptedLengthSum: 0, acceptedLengthCount: 0, acceptedSuggestionLengthSum: 0,
		};
		b.totalEvents++;
		b.suggestionLengthSum += event.suggestionLength;
		if (event.outcome === 'accept') { b.accepts++; }
		else if (event.outcome === 'reject') { b.rejects++; }
		else { b.ignores++; }
		if (typeof event.latencyMs === 'number' && Number.isFinite(event.latencyMs)) {
			b.latencySum += event.latencyMs;
			b.latencyCount++;
		}
		if (event.outcome === 'accept' && typeof event.acceptedLength === 'number' && Number.isFinite(event.acceptedLength)) {
			b.acceptedLengthSum += event.acceptedLength;
			b.acceptedLengthCount++;
			b.acceptedSuggestionLengthSum += event.suggestionLength;
		}
		buckets.set(event.modelId, b);
	}

	const rows: ModelLeaderboardRow[] = [];
	for (const [modelId, b] of buckets.entries()) {
		const acceptRate = b.totalEvents === 0 ? 0 : b.accepts / b.totalEvents;
		const rejectRate = b.totalEvents === 0 ? 0 : b.rejects / b.totalEvents;
		const avgSuggestionLength = b.totalEvents === 0 ? 0 : b.suggestionLengthSum / b.totalEvents;
		const avgLatencyMs = b.latencyCount === 0 ? null : b.latencySum / b.latencyCount;
		const keepRate = b.acceptedLengthCount === 0 || b.acceptedSuggestionLengthSum === 0
			? null
			: b.acceptedLengthSum / b.acceptedSuggestionLengthSum;
		rows.push({
			modelId,
			totalEvents: b.totalEvents,
			accepts: b.accepts,
			rejects: b.rejects,
			ignores: b.ignores,
			acceptRate,
			rejectRate,
			avgSuggestionLength,
			avgLatencyMs,
			keepRate,
		});
	}

	rows.sort((a, b) =>
		b.acceptRate - a.acceptRate
		|| b.totalEvents - a.totalEvents
		|| a.modelId.localeCompare(b.modelId)
	);

	const overallAcceptRate = totalInPeriod === 0 ? 0 : acceptsInPeriod / totalInPeriod;

	return {
		periodStart,
		periodEnd,
		totalEvents: totalInPeriod,
		overallAcceptRate,
		rows,
	};
}

function isValid(e: unknown): e is CompletionEvent {
	if (!e || typeof e !== 'object') { return false; }
	const obj = e as Record<string, unknown>;
	return typeof obj.timestamp === 'number'
		&& Number.isFinite(obj.timestamp)
		&& typeof obj.modelId === 'string'
		&& obj.modelId.length > 0
		&& (obj.outcome === 'accept' || obj.outcome === 'reject' || obj.outcome === 'ignore')
		&& typeof obj.suggestionLength === 'number'
		&& Number.isFinite(obj.suggestionLength)
		&& obj.suggestionLength >= 0;
}
