/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Performance guardrails dashboard aggregator (1059) — pure helper.
 *
 * `performanceGuardrailsService` records trip events when a runtime
 * threshold is exceeded (chunk gap, main-thread block, memory delta).
 * This module rolls those events up into per-rule rows the dashboard
 * panel renders and `vibe doctor --perf` exports.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type GuardrailRule = 'chunk-gap' | 'main-thread-block' | 'memory-delta' | 'fps-drop' | 'startup-time';

export interface GuardrailTripEvent {
	timestamp: number;
	rule: GuardrailRule;
	/** The observed value that crossed the threshold. */
	observedValue: number;
	thresholdValue: number;
	/** Optional context — operation name, file path, etc. */
	context?: string;
}

export interface GuardrailRuleSummary {
	rule: GuardrailRule;
	tripCount: number;
	maxObservedValue: number;
	avgObservedValue: number;
	thresholdValue: number;
	/** Most-frequent context (e.g. operation name) for this rule, or empty. */
	topContext: string;
	topContextCount: number;
}

export interface GuardrailDashboard {
	periodStart: number;
	periodEnd: number;
	totalTrips: number;
	rules: ReadonlyArray<GuardrailRuleSummary>;
}

/**
 * Aggregate guardrail events for `[periodStart, periodEnd]`. Pure.
 *
 * Out-of-range and malformed events are silently dropped. Stable
 * ordering: tripCount descending, then rule name ascending.
 */
export function aggregatePerfGuardrails(
	events: ReadonlyArray<GuardrailTripEvent>,
	periodStart: number,
	periodEnd: number,
): GuardrailDashboard {
	const buckets = new Map<GuardrailRule, {
		tripCount: number;
		maxObservedValue: number;
		sumObservedValue: number;
		thresholdValue: number;
		contextCounts: Map<string, number>;
	}>();

	let totalTrips = 0;
	for (const event of events) {
		if (!isValidEvent(event)) { continue; }
		if (event.timestamp < periodStart || event.timestamp > periodEnd) { continue; }

		totalTrips++;
		const b = buckets.get(event.rule) ?? {
			tripCount: 0,
			maxObservedValue: -Infinity,
			sumObservedValue: 0,
			thresholdValue: event.thresholdValue,
			contextCounts: new Map<string, number>(),
		};
		b.tripCount++;
		if (event.observedValue > b.maxObservedValue) {
			b.maxObservedValue = event.observedValue;
		}
		b.sumObservedValue += event.observedValue;
		// Threshold may shift over the period (config change). Keep the most-recent.
		b.thresholdValue = event.thresholdValue;
		if (event.context) {
			const cur = b.contextCounts.get(event.context) ?? 0;
			b.contextCounts.set(event.context, cur + 1);
		}
		buckets.set(event.rule, b);
	}

	const rules: GuardrailRuleSummary[] = [];
	for (const [rule, b] of buckets.entries()) {
		const { topContext, topContextCount } = pickTopContext(b.contextCounts);
		rules.push({
			rule,
			tripCount: b.tripCount,
			maxObservedValue: b.maxObservedValue === -Infinity ? 0 : b.maxObservedValue,
			avgObservedValue: b.tripCount === 0 ? 0 : b.sumObservedValue / b.tripCount,
			thresholdValue: b.thresholdValue,
			topContext,
			topContextCount,
		});
	}

	rules.sort((a, b) =>
		b.tripCount - a.tripCount
		|| a.rule.localeCompare(b.rule)
	);

	return { periodStart, periodEnd, totalTrips, rules };
}

function isValidEvent(e: unknown): e is GuardrailTripEvent {
	if (!e || typeof e !== 'object') { return false; }
	const obj = e as Record<string, unknown>;
	const validRules: GuardrailRule[] = ['chunk-gap', 'main-thread-block', 'memory-delta', 'fps-drop', 'startup-time'];
	return typeof obj.timestamp === 'number'
		&& Number.isFinite(obj.timestamp)
		&& validRules.includes(obj.rule as GuardrailRule)
		&& typeof obj.observedValue === 'number'
		&& Number.isFinite(obj.observedValue)
		&& typeof obj.thresholdValue === 'number'
		&& Number.isFinite(obj.thresholdValue);
}

function pickTopContext(counts: Map<string, number>): { topContext: string; topContextCount: number } {
	let top: string = '';
	let topCount = 0;
	for (const [ctx, count] of counts.entries()) {
		if (count > topCount || (count === topCount && (top === '' || ctx.localeCompare(top) < 0))) {
			top = ctx;
			topCount = count;
		}
	}
	return { topContext: top, topContextCount: topCount };
}

/**
 * Format the dashboard for `vibe doctor --perf`. Pure — caller writes
 * the output where it wants.
 */
export function renderGuardrailDashboardMarkdown(dashboard: GuardrailDashboard): string {
	const lines: string[] = [];
	const days = Math.max(1, Math.round((dashboard.periodEnd - dashboard.periodStart) / (24 * 60 * 60 * 1000)));
	lines.push('# VibeIDE — Performance guardrails report');
	lines.push('');
	lines.push(`Period: ${days} day(s) — ${dashboard.totalTrips} guardrail trips.`);
	if (dashboard.rules.length === 0) {
		lines.push('');
		lines.push('_No guardrail trips in the selected period._');
		return lines.join('\n');
	}
	lines.push('');
	lines.push('## By rule');
	lines.push('');
	for (const r of dashboard.rules) {
		lines.push(`- **${r.rule}** — ${r.tripCount} trips, max ${r.maxObservedValue}, avg ${Math.round(r.avgObservedValue)}, threshold ${r.thresholdValue}`);
		if (r.topContext.length > 0) {
			lines.push(`    - top context: \`${r.topContext}\` (${r.topContextCount} trips)`);
		}
	}
	return lines.join('\n');
}
