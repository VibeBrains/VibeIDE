/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A reasoning effort changed mid-conversation without breaking the prompt cache
 *
 * The request-level effort is part of the prefix the cache matches:
 * Moving the slider mid-thread rewrote it, and everything after was billed as fresh input
 * Both vendors keep the effort of the thread's first request in the request,
 * And put the change before the user message where the effort changed:
 * GPT-6 on Responses as a `configuration_update` item (quirk `effortByUpdate`,
 * developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation),
 * Claude on Anthropic's own API as an effort-only system message (quirk `effortBySystemMessage`,
 * platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta)
 *
 * The whole history goes with every request (`store: false`), and the vendor asks to replay each update at its place:
 * An answer remembers the effort its request was sent at (`effortMark`, `provider/model#effort`),
 * And the plan puts every update back before the user message that answer followed
 *
 * VibeIDEA's rule (`EffortUpdates`), so one thread costs the same in both products
 */

const MARK_SEPARATOR = '#';
const CONFIGURATION_UPDATE = 'configuration_update';

/** The mark an answer is stored with: who was asked and at what effort */
export function effortMarkOf(modelKey: string, effort: string): string {
	return `${modelKey}${MARK_SEPARATOR}${effort}`;
}

/** One message of the history as the plan sees it: its role, and an answer's mark */
export interface EffortTurn {
	readonly role: string;
	readonly effortMark?: string;
}

export interface EffortPlan {
	/** The effort the request carries: the thread's first one for this model, or the current one in a fresh thread */
	readonly requestEffort: string;
	/** Where updates go: before the user message with this ordinal among the user messages, at this effort */
	readonly updates: readonly { readonly beforeUserMessage: number; readonly effort: string }[];
	/** The mark the answer to this request is stored with */
	readonly mark: string;
}

/**
 * Where the effort changes in the history, for the model `modelKey` asked at `current` now
 * The answers of another model say nothing about this one: their marks are skipped
 */
export function planEffortUpdates(turns: readonly EffortTurn[], modelKey: string, current: string): EffortPlan {
	const prefix = modelKey + MARK_SEPARATOR;
	// The effort each user message was answered at: the mark of the first answer after it, for this model
	const answeredAt = new Map<number, string>();
	let pendingUser = -1;
	let lastUser = -1;
	turns.forEach((turn, index) => {
		if (turn.role === 'user') {
			pendingUser = index;
			lastUser = index;
		} else if (turn.role === 'assistant' && pendingUser >= 0 && turn.effortMark?.startsWith(prefix)) {
			answeredAt.set(pendingUser, turn.effortMark.slice(prefix.length));
			pendingUser = -1;
		}
	});
	const firstAnswered = [...answeredAt.keys()].sort((a, b) => a - b)[0];
	const requestEffort = firstAnswered === undefined ? current : answeredAt.get(firstAnswered)!;
	const updates: { beforeUserMessage: number; effort: string }[] = [];
	let effective = requestEffort;
	let userOrdinal = -1;
	turns.forEach((turn, index) => {
		if (turn.role !== 'user') { return; }
		userOrdinal++;
		const effort = index === lastUser ? current : answeredAt.get(index);
		if (effort !== undefined && effort !== effective) {
			updates.push({ beforeUserMessage: userOrdinal, effort });
			effective = effort;
		}
	});
	return { requestEffort, updates, mark: effortMarkOf(modelKey, current) };
}

/**
 * The Responses request body with the updates in place: before the n-th user message of `input`
 * A body that is not JSON, has no `input` or nothing to insert is returned untouched
 */
export function withConfigurationUpdates(body: string, updates: EffortPlan['updates']): string {
	if (updates.length === 0) { return body; }
	let parsed: { input?: unknown };
	try {
		parsed = JSON.parse(body);
	} catch {
		return body;
	}
	if (!Array.isArray(parsed.input)) { return body; }
	const byOrdinal = new Map(updates.map(update => [update.beforeUserMessage, update.effort]));
	const input: unknown[] = [];
	let userOrdinal = -1;
	for (const item of parsed.input) {
		if ((item as { role?: unknown } | null)?.role === 'user') {
			userOrdinal++;
			const effort = byOrdinal.get(userOrdinal);
			if (effort !== undefined) {
				input.push({ type: CONFIGURATION_UPDATE, reasoning: { effort } });
			}
		}
		input.push(item);
	}
	return JSON.stringify({ ...parsed, input });
}

/** The beta Anthropic's per-message effort needs: without it a system message with `output_config` is a 400 */
export const ANTHROPIC_MID_CONVERSATION_EFFORT_BETA = 'mid-conversation-output-config-2026-07-01';

/** The history as the plan sees it on the Anthropic wire, and the user messages an update cannot go before */
export interface AnthropicEffortTurns {
	readonly turns: readonly EffortTurn[];
	/** Ordinals, among user messages, of those the wire merges with tool results */
	readonly mixedUserMessages: ReadonlySet<number>;
}

/**
 * The history as Anthropic's wire carries it: consecutive user and tool messages go as one user message
 * A run with a user message in it counts as one user turn; a run of tool results alone is no user turn
 * A user turn that also carries tool results must directly follow the assistant's calls: no update can go before it
 * (platform.claude.com/docs/en/build-with-claude/effort, «Per-message effort»; the tool results rule of Messages)
 */
export function anthropicEffortTurns(messages: readonly EffortTurn[]): AnthropicEffortTurns {
	const turns: EffortTurn[] = [];
	const mixedUserMessages = new Set<number>();
	let userOrdinal = -1;
	let run: { hasUser: boolean; hasTool: boolean } | undefined;
	const closeRun = () => {
		if (!run) { return; }
		if (run.hasUser) {
			userOrdinal++;
			if (run.hasTool) { mixedUserMessages.add(userOrdinal); }
			turns.push({ role: 'user' });
		} else {
			turns.push({ role: 'tool' });
		}
		run = undefined;
	};
	for (const message of messages) {
		if (message.role === 'user' || message.role === 'tool') {
			run ??= { hasUser: false, hasTool: false };
			if (message.role === 'user') { run.hasUser = true; } else { run.hasTool = true; }
			continue;
		}
		closeRun();
		turns.push(message);
	}
	closeRun();
	return { turns, mixedUserMessages };
}

/**
 * The Anthropic request body with each update as an effort-only system message before the n-th user message
 * A user message is one with any block that is not a tool result: a message of tool results alone is no user turn
 * A body that is not JSON, has no `messages` or nothing to insert is returned untouched
 */
export function withAnthropicEffortUpdates(body: string, updates: EffortPlan['updates']): string {
	if (updates.length === 0) { return body; }
	let parsed: { messages?: unknown };
	try {
		parsed = JSON.parse(body);
	} catch {
		return body;
	}
	if (!Array.isArray(parsed.messages)) { return body; }
	const byOrdinal = new Map(updates.map(update => [update.beforeUserMessage, update.effort]));
	const messages: unknown[] = [];
	let userOrdinal = -1;
	for (const message of parsed.messages) {
		const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
		const userTurn = role === 'user' && (!Array.isArray(content) || content.some(block => (block as { type?: unknown } | null)?.type !== 'tool_result'));
		if (userTurn) {
			userOrdinal++;
			const effort = byOrdinal.get(userOrdinal);
			if (effort !== undefined) {
				messages.push({ role: 'system', content: [], output_config: { effort } });
			}
		}
		messages.push(message);
	}
	return JSON.stringify({ ...parsed, messages });
}

/**
 * The plan on Anthropic's wire: the history folded as the wire carries it, then the same rule as everywhere
 * An update that would have to go before a user message carrying tool results cannot go at all:
 * Such a request carries the effort asked now, as before — the cache restarts once, the request stays valid
 */
export function planAnthropicEffortUpdates(messages: readonly EffortTurn[], modelKey: string, current: string): EffortPlan {
	const { turns, mixedUserMessages } = anthropicEffortTurns(messages);
	const plan = planEffortUpdates(turns, modelKey, current);
	if (plan.updates.some(update => mixedUserMessages.has(update.beforeUserMessage))) {
		return { requestEffort: current, updates: [], mark: plan.mark };
	}
	return plan;
}
