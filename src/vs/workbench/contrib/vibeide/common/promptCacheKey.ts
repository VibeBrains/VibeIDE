/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `prompt_cache_key` of a conversation.
 *
 * Providers that route by this key (OpenAI, xAI) send every request carrying it to the server that
 * already holds its cached prefix; without it a request may land on a cold server and the whole input
 * is billed at the full rate. The key must stay the same on every turn of one conversation: a random key
 * per request never hits, and one constant for everything piles every conversation of every user onto
 * one key — they evict each other and overload one server.
 *
 * The thread id is hashed so the key says nothing about the conversation. The role keeps prompts with a
 * different prefix — plan generation has its own system prompt — off the agent's key, where they would
 * only evict it.
 */

import { StringSHA1 } from '../../../../base/common/hash.js';

/** Well under the provider limits; 128 bits of a hash cannot collide across one user's threads. */
const KEY_HASH_CHARS = 32;

export function promptCacheKeyOf(threadId: string, role: string): string {
	const sha = new StringSHA1();
	sha.update(`${threadId}\u0000${role}`);
	return `vibe-${sha.digest().slice(0, KEY_HASH_CHARS)}`;
}
