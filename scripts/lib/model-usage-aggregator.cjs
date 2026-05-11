/**
 * CJS mirror of common/modelUsageAggregator.ts
 * MUST stay in sync with the TypeScript source — no external dependencies.
 *
 * Usage:
 *   const { aggregateModelUsage, renderUsageMarkdown } = require('./model-usage-aggregator.cjs');
 */
'use strict';

const VALID_KINDS = new Set(['chat', 'completion', 'apply', 'plan', 'mcp']);

function isValidEvent(e) {
	if (!e || typeof e !== 'object') return false;
	return typeof e.timestamp === 'number'
		&& Number.isFinite(e.timestamp)
		&& typeof e.provider === 'string'
		&& typeof e.modelId === 'string'
		&& VALID_KINDS.has(e.kind)
		&& typeof e.inputTokens === 'number'
		&& Number.isFinite(e.inputTokens)
		&& e.inputTokens >= 0
		&& typeof e.outputTokens === 'number'
		&& Number.isFinite(e.outputTokens)
		&& e.outputTokens >= 0;
}

/**
 * @param {ReadonlyArray<object>} events
 * @param {number} periodStart
 * @param {number} periodEnd
 */
function aggregateModelUsage(events, periodStart, periodEnd) {
	const byKind = { chat: 0, completion: 0, apply: 0, plan: 0, mcp: 0 };
	const providerMap = new Map();

	let totalEvents = 0;
	let totalInput = 0;
	let totalOutput = 0;

	for (const event of events) {
		if (!isValidEvent(event)) continue;
		if (event.timestamp < periodStart || event.timestamp > periodEnd) continue;

		totalEvents++;
		totalInput += event.inputTokens;
		totalOutput += event.outputTokens;
		if (VALID_KINDS.has(event.kind)) byKind[event.kind]++;

		let provider = providerMap.get(event.provider);
		if (!provider) {
			provider = { events: 0, inputTokens: 0, outputTokens: 0, modelMap: new Map() };
			providerMap.set(event.provider, provider);
		}
		provider.events++;
		provider.inputTokens += event.inputTokens;
		provider.outputTokens += event.outputTokens;
		let model = provider.modelMap.get(event.modelId);
		if (!model) {
			model = { events: 0, totalTokens: 0 };
			provider.modelMap.set(event.modelId, model);
		}
		model.events++;
		model.totalTokens += event.inputTokens + event.outputTokens;
	}

	const byProvider = [];
	for (const [name, p] of providerMap.entries()) {
		const models = [...p.modelMap.entries()]
			.map(([modelId, v]) => ({ modelId, events: v.events, totalTokens: v.totalTokens }))
			.sort((a, b) => b.totalTokens - a.totalTokens || a.modelId.localeCompare(b.modelId));
		byProvider.push({
			provider: name,
			events: p.events,
			inputTokens: p.inputTokens,
			outputTokens: p.outputTokens,
			totalTokens: p.inputTokens + p.outputTokens,
			models,
		});
	}
	byProvider.sort((a, b) => b.totalTokens - a.totalTokens || a.provider.localeCompare(b.provider));

	return {
		periodStart,
		periodEnd,
		totalEvents,
		totalInputTokens: totalInput,
		totalOutputTokens: totalOutput,
		totalTokens: totalInput + totalOutput,
		byProvider,
		byKind,
	};
}

/**
 * @param {object} agg
 */
function renderUsageMarkdown(agg) {
	const lines = [];
	lines.push('# VibeIDE — Model usage report');
	lines.push('');
	const days = Math.max(1, Math.round((agg.periodEnd - agg.periodStart) / (24 * 60 * 60 * 1000)));
	lines.push(`Period: ${days} day(s) — ${agg.totalEvents} events, ${agg.totalTokens.toLocaleString('en-US')} tokens (${agg.totalInputTokens.toLocaleString('en-US')} in / ${agg.totalOutputTokens.toLocaleString('en-US')} out).`);
	lines.push('');
	if (agg.byProvider.length === 0) {
		lines.push('_No usage in the selected period._');
		return lines.join('\n');
	}
	lines.push('## By provider');
	lines.push('');
	for (const p of agg.byProvider) {
		lines.push(`- **${p.provider}** — ${p.events} events, ${p.totalTokens.toLocaleString('en-US')} tokens`);
		for (const m of p.models) {
			lines.push(`    - \`${m.modelId}\` — ${m.events} events, ${m.totalTokens.toLocaleString('en-US')} tokens`);
		}
	}
	return lines.join('\n');
}

module.exports = { aggregateModelUsage, renderUsageMarkdown };
