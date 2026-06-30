/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Budget-fill truncation pin for the most recent assistant↔tool exchange (roadmap 3074).
 *
 * The trimmer ranks messages by weight and truncates the heaviest. Tool-result messages
 * carry a 10× weight (LLM tokens are "cheaper" than user tokens), so a large freshly-read
 * file lands at the top of the chopping block. When it gets truncated the model loses the
 * content it JUST read and re-issues the same `read_file`, growing context in a loop
 * (observed #A: 41k→86k tokens, msgs:6, repeated reads of one file).
 *
 * This computes the indices of the last tool-result and the assistant turn that owns its
 * tool_use, so the caller can hard-pin them (weight 0, like the workspace-guidelines pin).
 *
 * **Safety valve:** if the pinned pair alone would exceed the budget, return an EMPTY set —
 * the pair must stay trimmable, otherwise the prompt can never fit and the caller throws
 * `PromptTooLong`. A genuinely oversized single result is the one case where dropping the
 * freshest content is still better than a hard failure.
 *
 * Pure & generic over `{ role, content }` so it unit-tests without the conversion service's
 * heavy imports.
 */

export interface PinnableMessage {
	readonly role: string;
	readonly content: string;
}

/**
 * @param messages   the trim-stage message array (system + chat, string content)
 * @param budgetChars character budget for the prompt; `<= 0` disables the safety valve
 *                    (treated as "unknown budget" → pin regardless)
 */
export function computeLastExchangePinSet(messages: readonly PinnableMessage[], budgetChars: number): ReadonlySet<number> {
	const pin = new Set<number>();

	// Most recent tool-result message.
	let lastToolIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'tool') { lastToolIdx = i; break; }
	}
	if (lastToolIdx === -1) { return pin; } // no tool exchange → nothing to protect

	// Nearest preceding assistant turn — the one that issued the tool_use.
	let assistantIdx = -1;
	for (let i = lastToolIdx - 1; i >= 0; i--) {
		if (messages[i].role === 'assistant') { assistantIdx = i; break; }
	}

	const pairLen = messages[lastToolIdx].content.length
		+ (assistantIdx >= 0 ? messages[assistantIdx].content.length : 0);

	// Safety valve: an over-budget pair must remain trimmable.
	if (budgetChars > 0 && pairLen > budgetChars) { return pin; }

	pin.add(lastToolIdx);
	if (assistantIdx >= 0) { pin.add(assistantIdx); }
	return pin;
}
