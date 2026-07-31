/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// CJS port of `common/perfGuardrailsAggregator.ts` for `vibe doctor --perf`.
// MUST stay in sync with that TS file (aggregatePerfGuardrails +
// renderGuardrailDashboardMarkdown semantics + sort stability).

'use strict';

const KNOWN_RULES = new Set(['chunk-gap', 'main-thread-block', 'memory-delta', 'fps-drop', 'startup-time']);

function isValidEvent(e) {
	return e != null && typeof e === 'object'
		&& KNOWN_RULES.has(e.rule)
		&& typeof e.timestamp === 'number' && Number.isFinite(e.timestamp)
		&& typeof e.observedValue === 'number' && Number.isFinite(e.observedValue)
		&& typeof e.thresholdValue === 'number' && Number.isFinite(e.thresholdValue);
}

function aggregatePerfGuardrails(events, periodStart, periodEnd) {
	const buckets = new Map();
	let totalTrips = 0;
	for (const event of (events || [])) {
		if (!isValidEvent(event)) {continue;}
		if (event.timestamp < periodStart || event.timestamp > periodEnd) {continue;}
		totalTrips++;
		let b = buckets.get(event.rule);
		if (!b) {
			b = { tripCount: 0, maxObservedValue: 0, sumObservedValue: 0, thresholdValue: event.thresholdValue, contextCounts: new Map() };
			buckets.set(event.rule, b);
		}
		b.tripCount++;
		b.sumObservedValue += event.observedValue;
		if (event.observedValue > b.maxObservedValue) {
			b.maxObservedValue = event.observedValue;
		}
		if (typeof event.context === 'string' && event.context.length > 0) {
			b.contextCounts.set(event.context, (b.contextCounts.get(event.context) ?? 0) + 1);
		}
	}
	const rules = [];
	for (const [rule, b] of buckets) {
		let topContext = '';
		let topContextCount = 0;
		for (const [ctx, count] of b.contextCounts) {
			if (count > topContextCount || (count === topContextCount && ctx < topContext)) {
				topContext = ctx;
				topContextCount = count;
			}
		}
		rules.push({
			rule,
			tripCount: b.tripCount,
			maxObservedValue: b.maxObservedValue,
			avgObservedValue: b.sumObservedValue / b.tripCount,
			thresholdValue: b.thresholdValue,
			topContext,
			topContextCount,
		});
	}
	rules.sort((a, b) => (b.tripCount - a.tripCount) || a.rule.localeCompare(b.rule));
	return { periodStart, periodEnd, totalTrips, rules };
}

function renderGuardrailDashboardMarkdown(dashboard) {
	const lines = [];
	lines.push('# Performance Guardrails — dashboard');
	lines.push('');
	lines.push(`Period: ${new Date(dashboard.periodStart).toISOString()} → ${new Date(dashboard.periodEnd).toISOString()}`);
	lines.push(`Total trips: **${dashboard.totalTrips}**`);
	lines.push('');
	if (dashboard.rules.length === 0) {
		lines.push('_No guardrail trips in the selected period._');
		return lines.join('\n');
	}
	lines.push('| Rule | Trips | Max | Avg | Threshold | Top context |');
	lines.push('|---|---:|---:|---:|---:|---|');
	for (const r of dashboard.rules) {
		const ctx = r.topContext ? `\`${r.topContext}\` (${r.topContextCount})` : '—';
		lines.push(`| ${r.rule} | ${r.tripCount} | ${r.maxObservedValue.toFixed(1)} | ${r.avgObservedValue.toFixed(1)} | ${r.thresholdValue.toFixed(1)} | ${ctx} |`);
	}
	return lines.join('\n');
}

module.exports = { aggregatePerfGuardrails, renderGuardrailDashboardMarkdown };
