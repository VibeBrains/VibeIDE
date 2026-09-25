/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The per-turn context block (`<turn_context>`) and where it lives in a conversation.
 *
 * The block rides at the start of a user's message and is stored with that message: a later request repeats it byte for
 * byte, so the conversation's prefix only grows at its end and the provider's cache survives an editor tab switch.
 */

import { ChatMessage } from './chatThreadServiceTypes.js';

/** Index of the last message a person wrote — a synthetic nudge carries no request and gets no context; -1 when none */
export function lastRealUserIndex(messages: readonly ChatMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === 'user' && !m.isSyntheticNudge) {
			return i;
		}
	}
	return -1;
}

/** Said in place of a file tree that is the same as the one an earlier message already carries */
export const FILES_OVERVIEW_UNCHANGED = '<files_overview>unchanged since an earlier message of this conversation</files_overview>';

const FILES_OVERVIEW = /<files_overview>[\s\S]*?<\/files_overview>/;

/**
 * The block without a file tree the conversation already holds
 *
 * The tree runs to ten thousand characters; repeated with every message it would cost more than the cache it saves.
 * It goes again only when it changed since the last message that carries one
 */
export function withoutRepeatedFilesOverview(block: string, earlierBlocks: readonly (string | undefined)[]): string {
	const tree = FILES_OVERVIEW.exec(block)?.[0];
	if (!tree) {
		return block;
	}
	for (let i = earlierBlocks.length - 1; i >= 0; i--) {
		const earlier = FILES_OVERVIEW.exec(earlierBlocks[i] ?? '')?.[0];
		if (earlier && earlier !== FILES_OVERVIEW_UNCHANGED) {
			return earlier === tree ? block.replace(tree, FILES_OVERVIEW_UNCHANGED) : block;
		}
	}
	return block;
}
