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
 *
 * One exception to "0 = allowed": a hook ported from Claude Code refuses with JSON on stdout and
 * keeps the code at 0 (see {@link foreignDecisionOf}). Read by the exit code alone, its refusal
 * reached the agent as advice while the action went through — so a deliberate "no" is honoured
 * whichever of the two contracts it is written in.
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
	/** Refused on purpose (exit 2, or a refusal written the way Claude Code writes it). For `preToolUse` the call must not happen. */
	| { readonly kind: 'refuse'; readonly text: string }
	/** The hook itself is broken; work continues and the user is told. */
	| { readonly kind: 'broken'; readonly text: string };

/** A decision printed by a hook written for Claude Code, where the exit code stays 0. */
export interface VibeForeignVerdict {
	readonly decision: 'refuse' | 'allow' | 'ask';
	readonly reason: string | undefined;
}

function trim(text: string): string {
	const flat = text.trim();
	return flat.length > VIBE_HOOK_OUTPUT_LIMIT ? `${flat.slice(0, VIBE_HOOK_OUTPUT_LIMIT)}\n… вывод обрезан` : flat;
}

function name(hook: VibeHook): string {
	return hook.label ?? hook.command;
}

function text(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const flat = value.trim();
	return flat.length ? flat : undefined;
}

function verdictFor(decision: string, reason: string | undefined): VibeForeignVerdict | undefined {
	switch (decision.toLowerCase()) {
		case 'deny':
		case 'block':
			return { decision: 'refuse', reason };
		case 'allow':
		case 'approve':
			return { decision: 'allow', reason };
		case 'ask':
			return { decision: 'ask', reason };
		default:
			return undefined;
	}
}

/**
 * The decision of a hook written for Claude Code, or `undefined` when stdout is an ordinary note.
 *
 * The JSON test is theirs verbatim — stdout is a decision only when it starts with `{` and ends
 * with `}` — so one hook behaves the same in both hosts and a note that merely mentions JSON stays
 * a note. Only documented shapes count: `hookSpecificOutput.permissionDecision`, the older
 * top-level `decision`, and `continue: false`, which is their way to say "stop here".
 */
export function foreignDecisionOf(stdout: string): VibeForeignVerdict | undefined {
	const flat = stdout.trim();
	if (!flat.startsWith('{') || !flat.endsWith('}')) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(flat);
	} catch {
		return undefined;
	}
	if (typeof parsed !== 'object' || parsed === null) {
		return undefined;
	}
	const root = parsed as Record<string, unknown>;
	const specific = root['hookSpecificOutput'];
	if (typeof specific === 'object' && specific !== null) {
		const permission = (specific as Record<string, unknown>)['permissionDecision'];
		if (typeof permission === 'string') {
			return verdictFor(permission, text((specific as Record<string, unknown>)['permissionDecisionReason']));
		}
	}
	const decision = root['decision'];
	if (typeof decision === 'string') {
		return verdictFor(decision, text(root['reason']));
	}
	if (root['continue'] === false) {
		return { decision: 'refuse', reason: text(root['stopReason']) };
	}
	return undefined;
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
	const foreign = foreignDecisionOf(run.stdout);
	if (foreign) {
		switch (foreign.decision) {
			case 'refuse':
				return { kind: 'refuse', text: foreign.reason ? trim(foreign.reason) : `Хук «${name(run.hook)}» отклонил действие без объяснения.` };
			// Ответ машине, а не сообщение агенту: показать {"decision":"allow"} заметкой — значит
			// класть JSON перед моделью на каждом разрешённом вызове.
			case 'allow':
				return { kind: 'ok' };
			// Третьего ответа у нас нет, а молчаливое «разрешено» потеряло бы намерение хука.
			case 'ask':
				return { kind: 'broken', text: `Хук «${name(run.hook)}» просит спросить человека: это решение «ask» из формата Claude Code, а наш хук отвечает только «можно» (код 0) или «нельзя» (код 2). Действие не остановлено — дальше решает режим разрешений.` };
		}
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
