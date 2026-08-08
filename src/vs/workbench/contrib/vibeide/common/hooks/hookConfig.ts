/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project hooks — deterministic commands the project runs around the agent's own loop.
 *
 * A hook is not another prompt. Rules ask the model to behave; a hook runs whatever the project
 * already trusts — a linter, a policy script, a test — and its exit code decides. That difference
 * is the whole point: "never touch migrations" is a wish, a `preToolUse` hook that exits 2 on a
 * path under `migrations/` is a fact.
 *
 * This module is the format and its parsing: no IO, no process spawning, so a malformed file and
 * every matching rule can be tested without a workspace.
 */

/** Points in the loop a project can attach to. */
export type VibeHookEvent =
	/** Before a tool runs. Exit 2 refuses the call and hands the reason to the agent. */
	| 'preToolUse'
	/** After a tool ran. Exit 2 does not undo it — it tells the agent to fix what it just did. */
	| 'postToolUse'
	/** After a turn finished (the agent stopped calling tools). */
	| 'turnEnd';

export const VIBE_HOOK_EVENTS: readonly VibeHookEvent[] = ['preToolUse', 'postToolUse', 'turnEnd'];

/** Default ceiling for one hook, in milliseconds. A hook is a check, not a build. */
export const VIBE_HOOK_DEFAULT_TIMEOUT_MS = 30000;

/** Hard ceiling: a project cannot ask for an unbounded hook, or a typo would hang every turn. */
export const VIBE_HOOK_MAX_TIMEOUT_MS = 300000;

export interface VibeHook {
	readonly event: VibeHookEvent;
	/** Shell command. Runs with the workspace folder as its working directory. */
	readonly command: string;
	/**
	 * Tool names this hook applies to; empty means every tool. Ignored for `turnEnd`.
	 * Matching is exact — a glob would quietly widen a rule the author wrote to be narrow.
	 */
	readonly tools: readonly string[];
	readonly timeoutMs: number;
	/** Human note shown in the IDE and to the agent when the hook refuses something. */
	readonly label: string | undefined;
}

export interface VibeHookConfig {
	readonly hooks: readonly VibeHook[];
	/** Problems found while reading: reported, never silently dropped. */
	readonly problems: readonly string[];
}

const EMPTY: VibeHookConfig = { hooks: [], problems: [] };

function asString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Parses `.vibe/hooks.json`.
 *
 * Unknown fields are ignored (the file must survive a newer VibeIDE), but a malformed **hook** is
 * dropped with a stated reason rather than half-applied: a hook that runs differently from what
 * its author wrote is worse than one that does not run.
 */
export function parseHookConfig(raw: string): VibeHookConfig {
	if (!raw.trim()) {
		return EMPTY;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { hooks: [], problems: [`Файл не читается как JSON: ${(e as Error).message}`] };
	}
	const list = (parsed as { hooks?: unknown })?.hooks;
	if (!Array.isArray(list)) {
		return { hooks: [], problems: ['Ожидался объект с массивом «hooks».'] };
	}

	const hooks: VibeHook[] = [];
	const problems: string[] = [];
	list.forEach((item, index) => {
		const record = item as Record<string, unknown> | null;
		const event = asString(record?.['event']) as VibeHookEvent | undefined;
		const command = asString(record?.['command']);
		if (!event || !VIBE_HOOK_EVENTS.includes(event)) {
			problems.push(`Хук №${index + 1}: неизвестное событие «${String(record?.['event'])}». Допустимо: ${VIBE_HOOK_EVENTS.join(', ')}.`);
			return;
		}
		if (!command) {
			problems.push(`Хук №${index + 1}: пустая команда.`);
			return;
		}
		const rawTools = record?.['tools'];
		const tools = Array.isArray(rawTools) ? rawTools.map(asString).filter((t): t is string => !!t) : [];
		if (event === 'turnEnd' && tools.length) {
			problems.push(`Хук №${index + 1}: «tools» не применяется к событию turnEnd — список проигнорирован.`);
		}
		const rawTimeout = record?.['timeoutMs'];
		let timeoutMs = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) ? Math.floor(rawTimeout) : VIBE_HOOK_DEFAULT_TIMEOUT_MS;
		if (timeoutMs <= 0) {
			timeoutMs = VIBE_HOOK_DEFAULT_TIMEOUT_MS;
		}
		if (timeoutMs > VIBE_HOOK_MAX_TIMEOUT_MS) {
			problems.push(`Хук №${index + 1}: таймаут ${timeoutMs} мс урезан до ${VIBE_HOOK_MAX_TIMEOUT_MS} мс.`);
			timeoutMs = VIBE_HOOK_MAX_TIMEOUT_MS;
		}
		hooks.push({ event, command, tools: event === 'turnEnd' ? [] : tools, timeoutMs, label: asString(record?.['label']) });
	});

	return { hooks, problems };
}

/** Hooks that apply to this event and tool, in file order — the project decides the sequence. */
export function hooksFor(config: VibeHookConfig, event: VibeHookEvent, toolName?: string): readonly VibeHook[] {
	return config.hooks.filter(hook => {
		if (hook.event !== event) {
			return false;
		}
		if (event === 'turnEnd' || !hook.tools.length) {
			return true;
		}
		return toolName !== undefined && hook.tools.includes(toolName);
	});
}
