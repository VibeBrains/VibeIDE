/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure logic behind the «hidden from the model's message» notice: what the buttons write into the setting,
 * and when the same rule is not announced again.
 *
 * Kept free of services so both halves can be tested without the workbench.
 */

/** Setting that lists the built-in rules the user switched off. */
export const SECRET_DISABLED_RULES_SETTING = 'vibeide.secretDetection.disabledPatternIds';

/** Rules past this many do not get a button of their own: the notice would grow into a wall. The settings button stays. */
export const MAX_DISABLE_RULE_BUTTONS = 3;

/** Scopes the ledger remembers; the oldest is dropped first. A turn is small, so this is about the last few dozen. */
const MAX_TRACKED_SCOPES = 64;

/** The list with `ruleId` in it once; the input is not touched. */
export function withRuleDisabled(ruleIds: readonly string[], ruleId: string): string[] {
	return ruleIds.includes(ruleId) ? [...ruleIds] : [...ruleIds, ruleId];
}

/** The list without `ruleId`; the input is not touched. */
export function withRuleEnabled(ruleIds: readonly string[], ruleId: string): string[] {
	return ruleIds.filter(id => id !== ruleId);
}

/** A message that opens a turn of the user: the agent's own nudges and replies do not. */
interface TurnMessage {
	readonly role: string;
	readonly isSyntheticNudge?: boolean;
}

/**
 * Identity of an agent turn as the user sees it: from their message to the next one of theirs.
 *
 * The transport that raises the notice has no turn of its own, and a thread-wide scope would hide the notice for a
 * new message too. A continuation after a tool approval is not a new turn: it does not add a user message, so it
 * keeps the scope and the rule is not announced a second time.
 */
export function secretNoticeScopeOf(threadId: string, messages: readonly TurnMessage[]): string {
	const turns = messages.filter(m => m.role === 'user' && !m.isSyntheticNudge).length;
	return `${threadId}#${turns}`;
}

/**
 * Remembers which rules were announced in which scope, so one rule is announced once per scope.
 *
 * Every request of an agent loop sends the whole history again, and a secret that sits in it is found again and
 * again: without this the same notice returns with every step of the turn.
 */
export class SecretNoticeLedger {

	private readonly _announced = new Map<string, Set<string>>();

	/**
	 * The rules that have not been announced in `scope` yet; they count as announced from now on.
	 * Without a scope there is nothing to compare against, and every rule is new.
	 */
	claim(scope: string | undefined, ruleIds: readonly string[]): string[] {
		if (scope === undefined) {
			return [...ruleIds];
		}
		let seen = this._announced.get(scope);
		if (!seen) {
			seen = new Set();
			this._announced.set(scope, seen);
			if (this._announced.size > MAX_TRACKED_SCOPES) {
				const oldest = this._announced.keys().next().value;
				if (oldest !== undefined) {
					this._announced.delete(oldest);
				}
			}
		}
		const fresh: string[] = [];
		for (const id of ruleIds) {
			if (!seen.has(id)) {
				seen.add(id);
				fresh.push(id);
			}
		}
		return fresh;
	}
}
