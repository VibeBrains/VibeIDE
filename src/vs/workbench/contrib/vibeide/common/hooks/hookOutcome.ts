/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VibeHook, VibeHookEvent } from './hookConfig.js';

/**
 * What a finished hook process means.
 *
 * The exit code is the contract, deliberately narrow:
 *
 * - **0** — allowed. Anything the hook printed becomes a note for the agent (a linter that fixed
 *   formatting should be able to say so).
 * - **2** — refused, with a reason. Chosen rather than 1 because 1 is what every broken script
 *   returns: a missing binary, a syntax error, a wrong path. If 1 blocked the agent, a typo in a
 *   hook would quietly lock the project.
 * - **anything else, a timeout, a spawn failure** — the hook is broken, and a broken check must
 *   not stop work. It is reported loudly and treated as "no opinion".
 *
 * That asymmetry is the safety property: a project can stop the agent only on purpose.
 */

/** Exit code a hook uses to refuse. */
export const VIBE_HOOK_REFUSE_EXIT_CODE = 2;

/** Longest hook output carried back to the agent; the rest is cut with a marker. */
export const VIBE_HOOK_OUTPUT_LIMIT = 4000;

export interface VibeHookRun {
	readonly hook: VibeHook;
	/** `undefined` when the process could not be started or was killed by the timeout. */
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

export type VibeHookVerdict =
	/** Nothing to say — the hook passed silently. */
	| { readonly kind: 'ok' }
	/** Passed and printed something worth handing to the agent. */
	| { readonly kind: 'note'; readonly text: string }
	/** Refused on purpose (exit 2). For `preToolUse` the call must not happen. */
	| { readonly kind: 'refuse'; readonly text: string }
	/** The hook itself is broken; work continues and the user is told. */
	| { readonly kind: 'broken'; readonly text: string };

function trim(text: string): string {
	const flat = text.trim();
	return flat.length > VIBE_HOOK_OUTPUT_LIMIT ? `${flat.slice(0, VIBE_HOOK_OUTPUT_LIMIT)}\n… вывод обрезан` : flat;
}

function name(hook: VibeHook): string {
	return hook.label ?? hook.command;
}

/** Turns a finished process into a verdict. */
export function verdictOf(run: VibeHookRun): VibeHookVerdict {
	if (run.timedOut) {
		return { kind: 'broken', text: `Хук «${name(run.hook)}» не уложился в ${run.hook.timeoutMs} мс и был остановлен. Работа продолжается: сломанный хук не должен блокировать агента.` };
	}
	if (run.exitCode === undefined) {
		return { kind: 'broken', text: `Хук «${name(run.hook)}» не запустился: ${trim(run.stderr) || 'причина неизвестна'}.` };
	}
	if (run.exitCode === VIBE_HOOK_REFUSE_EXIT_CODE) {
		const said = trim(run.stderr) || trim(run.stdout);
		return { kind: 'refuse', text: said || `Хук «${name(run.hook)}» отклонил действие без объяснения.` };
	}
	if (run.exitCode !== 0) {
		return { kind: 'broken', text: `Хук «${name(run.hook)}» завершился с кодом ${run.exitCode} (отказ — это код ${VIBE_HOOK_REFUSE_EXIT_CODE}). ${trim(run.stderr) || trim(run.stdout)}`.trim() };
	}
	const said = trim(run.stdout);
	return said ? { kind: 'note', text: said } : { kind: 'ok' };
}

export interface VibeHookDecision {
	/** True when a `preToolUse` hook refused: the tool call must not happen. */
	readonly blocked: boolean;
	/** Text handed to the agent, or `undefined` when the hooks had nothing to say. */
	readonly agentMessage: string | undefined;
	/** Problems with the hooks themselves, for the user rather than the model. */
	readonly brokenHooks: readonly string[];
}

/**
 * Folds the verdicts of one event into a single decision.
 *
 * A refusal wins over notes: if any hook said no, the agent must hear the no first — a list where
 * "запрещено" sits among three informational lines gets acted on as if it were advice.
 */
export function decideHooks(event: VibeHookEvent, verdicts: readonly VibeHookVerdict[]): VibeHookDecision {
	const refusals = verdicts.filter(v => v.kind === 'refuse').map(v => v.text);
	const notes = verdicts.filter(v => v.kind === 'note').map(v => v.text);
	const broken = verdicts.filter(v => v.kind === 'broken').map(v => v.text);

	if (refusals.length) {
		const head = event === 'preToolUse'
			? 'Действие остановлено проверкой проекта:'
			: 'Проверка проекта нашла проблему в том, что только что сделано:';
		return { blocked: event === 'preToolUse', agentMessage: [head, ...refusals].join('\n'), brokenHooks: broken };
	}
	return { blocked: false, agentMessage: notes.length ? notes.join('\n') : undefined, brokenHooks: broken };
}
