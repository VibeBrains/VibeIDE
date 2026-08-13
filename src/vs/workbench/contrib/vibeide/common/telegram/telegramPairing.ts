/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who is allowed to even ask for access. Pure decision logic — no IO — so every branch is
 * testable without a bot.
 *
 * The bot's username is public: anyone can find it and write to it. Access itself was always
 * gated by the owner's confirmation, but the confirmation dialog was not — a stranger could pop
 * a modal in the IDE with every message. The pairing code moves that gate one step earlier: a
 * message without the right code is dropped silently, so the owner never learns it happened.
 */

/** What to do with a message from a chat that is not bound yet. */
export type PairingDecision =
	/** Ask the owner (the code matched). */
	| { readonly kind: 'ask' }
	/** Say why, in the bot, without disturbing the owner. */
	| { readonly kind: 'reject'; readonly reply: string }
	/** Say nothing at all — a stranger must not learn whether the code even exists. */
	| { readonly kind: 'ignore' };

export interface PairingInput {
	/** Raw text of the message. */
	readonly text: string;
	/** Telegram chat type; only private chats may be bound. */
	readonly chatType: string | undefined;
	/** The code currently shown in the IDE settings. */
	readonly expectedCode: string;
	/** When this chat last triggered a confirmation prompt, or undefined if never. */
	readonly lastPromptAtMs: number | undefined;
	readonly nowMs: number;
}

/** Minimum gap between two confirmation prompts from the same chat. */
export const PAIRING_PROMPT_COOLDOWN_MS = 600000;

/**
 * Characters a pairing code is built from — no lookalikes (`l`/`o`/`0`/`1` are absent), so a code
 * read aloud or copied off a screen cannot turn into a different valid one. Shared by the generator
 * and by the normaliser, which keeps exactly these characters and drops the rest.
 */
export const PAIRING_CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/**
 * Decides what an unbound chat gets.
 *
 * A group chat is refused outright even with a valid code: there access belongs to the
 * membership list, which can change later without the owner noticing.
 */
export function decidePairing(input: PairingInput): PairingDecision {
	const expected = normalizePairingCode(input.expectedCode);
	// Only the first `expected.length` code characters count, so a code followed by words ("abcd-2345
	// привет") still matches while a longer string of code characters does not slip through.
	const code = normalizePairingCode(extractPairingCode(input.text))?.slice(0, expected?.length);
	if (!code || !expected || code !== expected) {
		// Deliberately silent, and deliberately the same outcome for "no code" and "wrong code":
		// any answer here would confirm the bot is live and let a stranger probe codes.
		return { kind: 'ignore' };
	}

	if (input.chatType && input.chatType !== 'private') {
		return {
			kind: 'reject',
			reply: 'Мост работает только в личном чате с ботом: в группе доступ получил бы её состав, а он может измениться без вашего ведома.',
		};
	}

	if (input.lastPromptAtMs !== undefined && input.nowMs - input.lastPromptAtMs < PAIRING_PROMPT_COOLDOWN_MS) {
		return {
			kind: 'reject',
			reply: 'Запрос на привязку уже отправлен — подтвердите его в VibeIDE.',
		};
	}

	return { kind: 'ask' };
}

/**
 * Pulls the code out of `/start <code>` or a bare code. A bare code is accepted because typing
 * `/start` before it on a phone is friction with no security value — the code is the secret.
 *
 * Returns everything after the command, not just the first word: the code is hyphenated, and a
 * hand-typed one arrives split by a space often enough that cutting at the first gap would throw
 * away its second half. Picking the code out of that remainder is `normalizePairingCode`'s job.
 */
export function extractPairingCode(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutCommand = trimmed.replace(/^\/start(@\S+)?\s*/i, '').trim();
	return withoutCommand || undefined;
}

/**
 * Reduces text to the characters a code is made of, in lower case.
 *
 * Comparison used to be byte-for-byte, and that is a bad fit for a secret people TYPE: the code
 * carries a hyphen, phones capitalise the first letter on their own, and a space instead of the
 * hyphen looks identical to its owner. All three failed silently and looked exactly like a dead
 * bridge — the pairing is answered with silence on purpose, so a stranger cannot probe codes.
 *
 * Security is unchanged: the alphabet has no lookalike characters (`generatePairingCode`), so
 * nothing collapses two distinct codes into one, and the number of guesses stays the same. Only
 * the tolerance for how it is typed grows.
 */
export function normalizePairingCode(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const kept = text.toLowerCase().split('').filter(ch => PAIRING_CODE_ALPHABET.includes(ch)).join('');
	return kept || undefined;
}

/**
 * Builds a pairing code: two short words plus digits, from a fixed alphabet without lookalike
 * characters. Readable aloud and typeable on a phone, unlike a raw UUID.
 *
 * `randomInt` is injected so the generator stays pure and testable.
 */
export function generatePairingCode(randomInt: (maxExclusive: number) => number): string {
	const alphabet = PAIRING_CODE_ALPHABET;
	let out = '';
	for (let i = 0; i < 8; i++) {
		out += alphabet[randomInt(alphabet.length)];
	}
	return `${out.slice(0, 4)}-${out.slice(4)}`;
}
