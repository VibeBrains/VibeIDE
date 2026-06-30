/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Model usage transparency aggregator (1183 — public model usage transparency).
 *
 * Pure helper that walks a list of usage events and produces a summary the
 * Settings panel / `vibe-transparency-dashboard.js` can render. Aggregation
 * is deterministic (same input → same output), no clock reads, no network.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type UsageEventKind = 'chat' | 'completion' | 'apply' | 'plan' | 'mcp';

export interface ModelUsageEvent {
	timestamp: number; // unix ms
	provider: string;  // 'anthropic' | 'openai' | 'ollama' | …
	modelId: string;   // 'claude-sonnet-4-6' | 'qwen2.5-coder:7b' | …
	kind: UsageEventKind;
	inputTokens: number;
	outputTokens: number;
}

export interface ProviderTotal {
	provider: string;
	events: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	models: ReadonlyArray<{ modelId: string; events: number; totalTokens: number }>;
}

export interface UsageAggregation {
	periodStart: number;
	periodEnd: number;
	totalEvents: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalTokens: number;
	byProvider: ReadonlyArray<ProviderTotal>;
	byKind: Readonly<Record<UsageEventKind, number>>;
}

/**
 * Aggregate `events` falling inside `[periodStart, periodEnd]` (inclusive).
 * Pure — does not mutate input. Stable ordering: providers sorted by total
 * tokens descending; models within each provider sorted the same way; ties
 * broken by name ascending.
 *
 * Out-of-range timestamps and non-positive tokens are silently dropped (a
 * partial / malformed event log shouldn't crash the dashboard).
 */
export function aggregateModelUsage(
	events: ReadonlyArray<ModelUsageEvent>,
	periodStart: number,
	periodEnd: number,
): UsageAggregation {
	const safeKinds: UsageEventKind[] = ['chat', 'completion', 'apply', 'plan', 'mcp'];
	const byKind: Record<UsageEventKind, number> = {
		chat: 0, completion: 0, apply: 0, plan: 0, mcp: 0,
	};
	const providerMap = new Map<string, {
		events: number;
		inputTokens: number;
		outputTokens: number;
		modelMap: Map<string, { events: number; totalTokens: number }>;
	}>();

	let totalEvents = 0;
	let totalInput = 0;
	let totalOutput = 0;

	for (const event of events) {
		if (!isValidEvent(event)) { continue; }
		if (event.timestamp < periodStart || event.timestamp > periodEnd) { continue; }

		totalEvents++;
		totalInput += event.inputTokens;
		totalOutput += event.outputTokens;
		if (safeKinds.includes(event.kind)) {
			byKind[event.kind]++;
		}

		const provider = providerMap.get(event.provider) ?? {
			events: 0, inputTokens: 0, outputTokens: 0, modelMap: new Map(),
		};
		provider.events++;
		provider.inputTokens += event.inputTokens;
		provider.outputTokens += event.outputTokens;
		const model = provider.modelMap.get(event.modelId) ?? { events: 0, totalTokens: 0 };
		model.events++;
		model.totalTokens += event.inputTokens + event.outputTokens;
		provider.modelMap.set(event.modelId, model);
		providerMap.set(event.provider, provider);
	}

	const byProvider: ProviderTotal[] = [];
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

function isValidEvent(e: unknown): e is ModelUsageEvent {
	if (!e || typeof e !== 'object') { return false; }
	const obj = e as Record<string, unknown>;
	return typeof obj.timestamp === 'number'
		&& Number.isFinite(obj.timestamp)
		&& typeof obj.provider === 'string'
		&& typeof obj.modelId === 'string'
		&& (obj.kind === 'chat' || obj.kind === 'completion' || obj.kind === 'apply' || obj.kind === 'plan' || obj.kind === 'mcp')
		&& typeof obj.inputTokens === 'number'
		&& Number.isFinite(obj.inputTokens)
		&& obj.inputTokens >= 0
		&& typeof obj.outputTokens === 'number'
		&& Number.isFinite(obj.outputTokens)
		&& obj.outputTokens >= 0;
}

/**
 * Markdown export for `vibe doctor --transparency` and PR / compliance audit.
 * Pure formatting helper — caller decides whether to write to file or copy.
 */
export function renderUsageMarkdown(agg: UsageAggregation): string {
	const lines: string[] = [];
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
