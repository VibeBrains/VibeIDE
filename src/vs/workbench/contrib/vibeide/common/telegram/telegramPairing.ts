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
 * Decides what an unbound chat gets.
 *
 * A group chat is refused outright even with a valid code: there access belongs to the
 * membership list, which can change later without the owner noticing.
 */
export function decidePairing(input: PairingInput): PairingDecision {
	const code = extractPairingCode(input.text);
	if (!code || code !== input.expectedCode) {
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
 */
export function extractPairingCode(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed) {
		return undefined;
	}
	const withoutCommand = trimmed.replace(/^\/start(@\S+)?\s*/i, '');
	const candidate = withoutCommand.split(/\s+/)[0]?.trim();
	return candidate || undefined;
}

/**
 * Builds a pairing code: two short words plus digits, from a fixed alphabet without lookalike
 * characters. Readable aloud and typeable on a phone, unlike a raw UUID.
 *
 * `randomInt` is injected so the generator stays pure and testable.
 */
export function generatePairingCode(randomInt: (maxExclusive: number) => number): string {
	const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
	let out = '';
	for (let i = 0; i < 8; i++) {
		out += alphabet[randomInt(alphabet.length)];
	}
	return `${out.slice(0, 4)}-${out.slice(4)}`;
}
