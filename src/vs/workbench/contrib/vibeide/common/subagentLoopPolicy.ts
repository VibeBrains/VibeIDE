/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { approvalTypeOfBuiltinToolName } from './prompt/tools/index.js';
import type { ExploreSubagentReport } from './vibeSubagentService.js';
import type { LLMTokenUsage } from './sendLLMMessageTypes.js';

/**
 * Pure decision logic for the headless subagent tool-loop (Phase 3b).
 * The runner (`browser/vibeSubagentRunnerService.ts`) drives LLM/tool services;
 * everything decidable without I/O lives here so it is unit-testable.
 */

/** Max CONSECUTIVE rejected tool calls (whitelist rejection / invalid params / manual reject) before the
 *  role is declared stuck. Reset on any clean tool execution — a role making progress with the occasional
 *  misfire must not accumulate toward a stop over a long (autopilot-extended) run. */
export const SUBAGENT_MAX_DENIED_ACTIONS = 5;

/** Rough chars→tokens estimate (≈4 chars/token) — used for the subagent quota, flagged as estimate. */
export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Real per-hop token cost for the subagent quota, from the provider's reported usage:
 * uncached input (prompt − prompt-cache hits) + output. Prompt-cached re-sent history is
 * excluded, so later hops are charged only their genuine delta. Falls back to the char
 * estimate when usage is absent (e.g. an early abort/timeout yields no usage). This avoids
 * the chars/4-of-`JSON.stringify(messages)` proxy, which overcounts input ~2-3× (JSON
 * key/escape overhead) and exhausted a role's quota on the very first hop.
 */
export function hopTokenCost(usage: LLMTokenUsage | undefined, fallbackChars: number): number {
	if (usage && (usage.promptTokens !== undefined || usage.completionTokens !== undefined)) {
		const uncachedInput = Math.max(0, (usage.promptTokens ?? 0) - (usage.cachedInputTokens ?? 0));
		return uncachedInput + (usage.completionTokens ?? 0);
	}
	return estimateTokensFromChars(fallbackChars);
}

export interface SubagentLoopLimits {
	readonly maxSteps: number;
	/** Estimated-token ceiling for this subagent (0 = unlimited). */
	readonly maxTokensEst: number;
	/** Absolute deadline (unix ms); 0 = no wall-clock limit. */
	readonly deadlineAtMs: number;
	readonly maxDeniedActions: number;
}

export interface SubagentLoopState {
	readonly stepsDone: number;
	readonly tokensUsedEst: number;
	readonly deniedActions: number;
	readonly nowMs: number;
	/** Cooperative cancellation (audit A): parent disposed the subagent — highest-priority stop. */
	readonly cancelled: boolean;
}

export type SubagentStopReason = 'cancelled' | 'max-steps' | 'deadline' | 'token-budget' | 'denied-actions';

/** Decide whether the loop must stop BEFORE the next LLM hop. `undefined` = keep going. */
export function decideStop(state: SubagentLoopState, limits: SubagentLoopLimits): SubagentStopReason | undefined {
	if (state.cancelled) { return 'cancelled'; }
	if (state.stepsDone >= limits.maxSteps) { return 'max-steps'; }
	if (limits.deadlineAtMs > 0 && state.nowMs >= limits.deadlineAtMs) { return 'deadline'; }
	if (limits.maxTokensEst > 0 && state.tokensUsedEst >= limits.maxTokensEst) { return 'token-budget'; }
	if (state.deniedActions >= limits.maxDeniedActions) { return 'denied-actions'; }
	return undefined;
}

export function stopReasonToRussian(reason: SubagentStopReason): string {
	switch (reason) {
		case 'cancelled': return 'отменён родителем';
		case 'max-steps': return 'исчерпан лимит шагов';
		case 'deadline': return 'исчерпан лимит времени';
		case 'token-budget': return 'исчерпана токен-квота';
		case 'denied-actions': return 'модель повторно вызывала недоступные роли инструменты или с неверными параметрами (не одобрение — отбраковал раннер)';
	}
}

/** Cut `s` to `max` characters from the start — for text whose beginning says what it is. */
export function truncateSummary(s: string, max: number): string {
	const trimmed = s.trim();
	return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/**
 * How much of a role's answer travels on: to the parent, the next pipeline step, the ledger.
 *
 * 2000, VibeIDEA's figure for the same hand-over: the shared `pipelines.json` runs in both products,
 * and a reviewer whose answer survives in one and is cut in the other is the same pipeline doing two
 * different things. The old 500 lost the end of any real review.
 */
export const RESULT_SUMMARY_MAX_CHARS = 2000;

/**
 * The end of a role's answer, at most `max` characters.
 *
 * The end, not the beginning: a role finishes with its conclusion — the reviewer's «ВЕРДИКТ:» line,
 * the acceptance lines, the list of files — and a head cut kept the preamble and dropped exactly that.
 */
export function summaryTail(s: string, max: number): string {
	const trimmed = s.trim();
	if (trimmed.length <= max) {
		return trimmed;
	}
	return max <= 1 ? '…' : `…${trimmed.slice(trimmed.length - (max - 1))}`;
}

/**
 * Map a role's tool whitelist onto a ChatMode for prompt-side tool exposure:
 * a role allowed ANY approval-requiring tool (write/terminal) runs as 'agent',
 * a purely read-only role runs as 'gather' — that mode's prompt already excludes
 * every approval-requiring tool, so the model never even sees write tools.
 */
export function chatModeForAllowedTools(allowedTools: readonly string[]): 'agent' | 'gather' {
	return allowedTools.some(t => Object.hasOwn(approvalTypeOfBuiltinToolName, t)) ? 'agent' : 'gather';
}

/** Path-ish values from raw tool params — feeds artifacts / explore-report paths. */
export function collectPathsFromRawParams(rawParams: Record<string, unknown>): string[] {
	const out: string[] = [];
	for (const key of ['uri', 'path', 'file', 'filePath', 'fileName']) {
		const v = rawParams[key];
		if (typeof v === 'string' && v.trim()) { out.push(v.trim()); }
	}
	return out;
}

/** Compact explore report from loop facts. Citations are a later refinement — paths carry the signal. */
export function buildExploreReport(touchedPaths: readonly string[], truncated: boolean): ExploreSubagentReport {
	const paths = [...new Set(touchedPaths)].slice(0, 50);
	return {
		paths,
		citations: [],
		confidence: truncated ? 0.35 : (paths.length > 0 ? 0.7 : 0.4),
		truncated,
		...(truncated ? { truncationSuggestion: 'retry' as const } : {}),
	};
}

/**
 * First user message of the isolated transcript: role framing + goal + optional context.
 *
 * `diff` is a ready block — the changes a pipeline hands a judging step — and goes after the context:
 * the task says what to judge, the diff is the material.
 */
export function buildSubagentTaskMessage(opts: { displayName: string; systemAppendix: string; goal: string; acceptanceCriteria?: string; contextItems?: readonly string[]; diff?: string }): string {
	const parts: string[] = [];
	parts.push(`Ты выполняешь роль: ${opts.displayName}.`);
	if (opts.systemAppendix.trim()) { parts.push(opts.systemAppendix.trim()); }
	parts.push(`Задача: ${opts.goal.trim()}`);
	if (opts.acceptanceCriteria?.trim()) { parts.push(`Критерии приёмки: ${opts.acceptanceCriteria.trim()}`); }
	if (opts.contextItems?.length) { parts.push(`Контекст (файлы/ссылки): ${opts.contextItems.join(', ')}`); }
	if (opts.diff?.trim()) { parts.push(opts.diff.trim()); }
	parts.push('Работай автономно. Когда задача выполнена — заверши ход инструментом vibe_complete с кратким итогом (если vibe_complete недоступен — просто закончи ответ кратким итогом без вызова инструментов).');
	return parts.join('\n\n');
}
