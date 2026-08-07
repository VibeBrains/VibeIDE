/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VibeTelegramApprovalDecision } from './vibeTelegramTypes.js';

/**
 * What a button press means. Telegram gives us only `callback_data` — at most 64 bytes — so the
 * meaning has to fit in a short prefixed string, and anything longer (a project name, a prompt)
 * travels as the tail rather than as an index into state the main process would have to keep.
 */
export type VibeTelegramCallback =
	| { readonly kind: 'approval'; readonly token: string; readonly decision: VibeTelegramApprovalDecision }
	/** A remote-control button: behaves exactly as if the user had typed `text` in the chat. */
	| { readonly kind: 'command'; readonly text: string }
	| { readonly kind: 'unknown' };

/** Longest `callback_data` Telegram accepts, in bytes. */
export const TELEGRAM_CALLBACK_DATA_LIMIT = 64;

/** Prefix marking a remote-control button; the tail is the command to run. */
const COMMAND_PREFIX = 'c:';

/** Builds `callback_data` for a command button, or `undefined` when the command will not fit. */
export function encodeCommandCallback(command: string): string | undefined {
	const data = `${COMMAND_PREFIX}${command}`;
	// Measured in bytes, not characters: a Cyrillic project name is two bytes per letter, and a
	// button Telegram refuses would silently break the whole keyboard.
	return new TextEncoder().encode(data).length <= TELEGRAM_CALLBACK_DATA_LIMIT ? data : undefined;
}

/** Reads `callback_data` back. Unknown shapes are reported, never guessed into an approval. */
export function parseTelegramCallback(data: string): VibeTelegramCallback {
	if (data.startsWith(COMMAND_PREFIX)) {
		const text = data.slice(COMMAND_PREFIX.length).trim();
		return text ? { kind: 'command', text } : { kind: 'unknown' };
	}
	const decision: VibeTelegramApprovalDecision | undefined =
		data.startsWith('ok:') ? 'approve'
			: data.startsWith('no:') ? 'reject'
				: data.startsWith('ed:') ? 'amend'
					: undefined;
	if (!decision) {
		return { kind: 'unknown' };
	}
	const token = data.slice(3).trim();
	return token ? { kind: 'approval', token, decision } : { kind: 'unknown' };
}
