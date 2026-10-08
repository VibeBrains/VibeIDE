/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A reasoning effort changed mid-conversation without breaking the prompt cache (quirk `effortByUpdate`, GPT-6)
 *
 * The request-level `reasoning.effort` is part of the prefix the cache matches:
 * Moving the slider mid-thread rewrote it, and everything after was billed as fresh input
 * The vendor's way keeps the effort of the thread's first request in the request,
 * And puts a `configuration_update` item before the user message where the effort changed
 * (developers.openai.com/api/docs/guides/reasoning#change-reasoning-mid-conversation)
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
