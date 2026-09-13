/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LLMTokenUsage } from './sendLLMMessageTypes.js';

/**
 * Tokens an orchestrator model spends on its own internal calls — billed, and absent from the
 * `usage` the AI SDK normalises.
 *
 * WHY: Sakana Fugu runs several model calls behind one answer and bills them as ordinary input and
 * output ON TOP of `prompt_tokens` / `completion_tokens` (unlike reasoning tokens, which live inside
 * them). The SDK passes only the standard fields through, so the ledger and every spend ceiling saw
 * the visible part of the bill — by a third-party breakdown, 1 300 tokens on a trivial request and
 * 6–20 thousand on a hard one were simply missing.
 *
 * The vendor does not publish the field shape (checked 13.09.2026). Two shapes are known from
 * secondary sources and both are read: flat `usage.orchestration_*` and the same names under
 * `usage.token_details`. The rules are VibeIDEA's `TokenUsage.fromOpenAiChunk`, word for word, so
 * the two products bill one turn identically:
 *   - the nested object wins when present; the two shapes are NEVER added together;
 *   - orchestration input goes to input, its cached part to cache, orchestration output to output.
 *
 * Pure: a raw response tail in, a usage delta out.
 */

/** Orchestration tokens found in one response, or `undefined` when there are none. */
export interface OrchestrationTokens {
	readonly input: number;
	readonly output: number;
	readonly cachedInput: number;
}

const FIELDS = {
	input: 'orchestration_input_tokens',
	output: 'orchestration_output_tokens',
	cachedInput: 'orchestration_input_cached_tokens',
} as const;

function count(source: Record<string, unknown>, field: string): number {
	const value = source[field];
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Orchestration tokens of one parsed `usage` object — see the module note for which shape wins. */
export function orchestrationTokensOfUsage(usage: unknown): OrchestrationTokens | undefined {
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}
	const flat = usage as Record<string, unknown>;
	const nested = flat['token_details'];
	const source = nested && typeof nested === 'object' ? nested as Record<string, unknown> : flat;
	const tokens = {
		input: count(source, FIELDS.input),
		output: count(source, FIELDS.output),
		cachedInput: count(source, FIELDS.cachedInput),
	};
	return tokens.input || tokens.output || tokens.cachedInput ? tokens : undefined;
}

/**
 * Orchestration tokens from the tail of a raw OpenAI-compatible response: an SSE stream (`data:`
 * lines) or a plain JSON body. The LAST `usage` wins — providers repeat it as the stream grows, and
 * the final chunk carries the totals. A tail cut in the middle of a line is skipped, not guessed at.
 */
export function orchestrationTokensOfTail(tail: string): OrchestrationTokens | undefined {
	if (!tail.includes('orchestration_')) {
		return undefined;
	}
	const candidates: string[] = [];
	for (const rawLine of tail.split('\n')) {
		const line = rawLine.trim();
		if (!line.includes('orchestration_')) {
			continue;
		}
		candidates.push(line.startsWith('data:') ? line.slice(5).trim() : line);
	}
	for (let i = candidates.length - 1; i >= 0; i--) {
		try {
			const parsed = JSON.parse(candidates[i]) as { usage?: unknown };
			const tokens = orchestrationTokensOfUsage(parsed.usage);
			if (tokens) {
				return tokens;
			}
		} catch {
			// A line cut by the tail window: an older complete one may still hold the totals.
		}
	}
	return undefined;
}

/** The usage the ledger should bill: the SDK's numbers plus what the orchestrator spent. */
export function withOrchestration(usage: LLMTokenUsage | undefined, tokens: OrchestrationTokens | undefined): LLMTokenUsage | undefined {
	if (!tokens) {
		return usage;
	}
	const add = (base: number | undefined, extra: number) => (base ?? 0) + extra;
	return {
		...usage,
		promptTokens: add(usage?.promptTokens, tokens.input),
		completionTokens: add(usage?.completionTokens, tokens.output),
		cachedInputTokens: add(usage?.cachedInputTokens, tokens.cachedInput),
		...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens + tokens.input + tokens.output } : {}),
	};
}
