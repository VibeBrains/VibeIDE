/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which earlier thinking blocks may still be replayed, when the request cannot ask the vendor to drop stale ones
 *
 * Claude binds a thinking block to the prefix it was produced under: model, system prompt, tools and the history before
 * it. Replayed under a changed prefix, the block answers 400 on accounts where the vendor enforces the binding.
 * Adaptive thinking asks the vendor to drop such a block (`block_binding: drop_block`); Sonnet 5.5's «off» mode
 * `between_tools` refuses that field, and the vendor's own advice is to strip the blocks from the edited turn on.
 *
 * Every assistant turn keeps the fingerprint of the prefix it was produced under. On the next send the same rolling
 * fingerprint is recomputed over the history as it goes now; the first turn whose fingerprint differs, and every turn
 * after it, loses its blocks. Valid blocks stay: stripping them would break the provider's prefix cache for nothing.
 * Pure, no I/O.
 */

/** What makes the head of the prefix: everything that is not a message */
export interface ReasoningPrefixHead {
	readonly model: string;
	readonly system: string;
	readonly instructions: string;
	readonly chatMode: string;
	/** Names of the tools offered on top of the built-in set (MCP); order does not matter */
	readonly extraTools: readonly string[];
}

/** The fields of a history message this module reads; anything else on the message is carried through untouched */
export interface PrefixMessage {
	readonly role: string;
	readonly anthropicReasoning?: readonly unknown[] | null;
	/** Fingerprint of the prefix the assistant turn was produced under, when it was recorded */
	readonly reasoningPrefix?: string;
}

/** cyrb53: a fast 53-bit string hash — the fingerprint only has to tell two prefixes apart, not resist an attacker */
function hash53(text: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The fingerprint of the head: a different model, system prompt, rules, mode or tool set is a different prefix */
export function reasoningPrefixHeadOf(head: ReasoningPrefixHead): string {
	return hash53(JSON.stringify([head.model, head.system, head.instructions, head.chatMode, [...head.extraTools].sort()]));
}

/** One step of the rolling fingerprint: the prefix so far plus the message as it goes on the wire */
function step(prefix: string, message: PrefixMessage): string {
	const { reasoningPrefix: _ownPrefix, ...sent } = message as PrefixMessage & Record<string, unknown>;
	return hash53(`${prefix}\u0000${JSON.stringify(sent)}`);
}

/**
 * The history to send, with thinking blocks stripped from the first turn produced under a different prefix on, and the
 * fingerprint of the whole prefix — the one the answer to this request is produced under
 *
 * @param strip only the «off» position of a model-bound family strips; otherwise the history goes as it is and only the
 * fingerprint is computed, so a later switch to «off» finds every turn already fingerprinted
 */
export function guardReasoningPrefix<M extends PrefixMessage>(messages: readonly M[], head: string, strip: boolean): { readonly messages: M[]; readonly prefix: string } {
	let prefix = head;
	let stale = false;
	const out: M[] = [];
	for (const message of messages) {
		let sent = message;
		if (strip && message.role === 'assistant' && message.anthropicReasoning && message.anthropicReasoning.length > 0) {
			// A turn with no recorded fingerprint predates it: there is nothing to prove its blocks still match
			stale ||= message.reasoningPrefix !== prefix;
			if (stale) {
				sent = { ...message, anthropicReasoning: null };
			}
		}
		out.push(sent);
		prefix = step(prefix, sent);
	}
	return { messages: out, prefix };
}
