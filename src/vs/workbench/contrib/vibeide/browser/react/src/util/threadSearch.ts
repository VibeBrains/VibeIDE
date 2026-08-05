/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Adapter between chat threads and the pure transcript search.
 *
 * Lives here because BOTH history surfaces need it — the full panel and the composer's dropdown.
 * They used to carry a copy of the same "compare the query with the first user message" filter,
 * so a search that reads whole conversations had to be added twice or it would work in one place
 * and not the other. One adapter, one hook, one behaviour.
 */

import { useEffect, useMemo, useState } from 'react';
import { PreparedTranscripts, prepareTranscripts, searchPrepared, TranscriptHit, TranscriptThread } from '../../../../common/transcriptSearch.js';
import type { ThreadType } from '../../../chatThreadService.js';
import type { ChatMessage } from '../../../../common/chatThreadServiceTypes.js';

/** Long enough that a typed word is searched once, short enough to feel immediate. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Value that settles `delay` after the last change — the search input's own rhythm. */
export function useDebounced<T>(value: T, delay: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return settled;
}

/** Chat thread → what the search sees. Roles beyond user/assistant are the loop's own machinery. */
export function toTranscriptThread(thread: ThreadType): TranscriptThread {
	return {
		threadId: thread.id,
		lastModified: new Date(thread.lastModified).getTime(),
		messages: thread.messages.map((message: ChatMessage) => ({
			role: message.role === 'user' || message.role === 'assistant' ? message.role : 'other',
			// `displayContent` is what the user actually saw; `content` carries the raw payload for
			// roles that have one. Searching what was shown keeps results explainable.
			text: (message as { displayContent?: string; content?: string }).displayContent
				|| (message as { content?: string }).content
				|| '',
		})),
	};
}

/**
 * Normalised text per thread OBJECT. Threads are immutable in the store, so a thread that gained a
 * message is a new object and misses the cache, while the hundreds that did not change hit it —
 * one edited conversation costs one conversation of work, not the whole history. Weak keys mean a
 * deleted thread's entry leaves with it.
 */
const normalisedCache = new WeakMap<ThreadType, { transcript: TranscriptThread; normalised: readonly string[] }>();

function prepareCached(threads: readonly ThreadType[]): PreparedTranscripts {
	const transcripts: TranscriptThread[] = [];
	const normalised: (readonly string[])[] = [];
	for (const thread of threads) {
		let entry = normalisedCache.get(thread);
		if (!entry) {
			const transcript = toTranscriptThread(thread);
			entry = { transcript, normalised: prepareTranscripts([transcript]).normalised[0] };
			normalisedCache.set(thread, entry);
		}
		transcripts.push(entry.transcript);
		normalised.push(entry.normalised);
	}
	return { threads: transcripts, normalised };
}

/**
 * Hits by thread id for the current query, or `null` while the query is empty — callers treat
 * `null` as "not filtering" rather than "nothing found", and the two must not be confused.
 *
 * Debounced inside: scanning every message of every thread on each keystroke is work nobody sees.
 */
export function useThreadSearch(threads: readonly ThreadType[], rawQuery: string): Map<string, TranscriptHit> | null {
	const query = useDebounced(rawQuery.trim(), SEARCH_DEBOUNCE_MS);
	// Two separate savings, both measured on a 500-thread × 60-message history:
	//   • normalising is the expensive half (550 ms) and does not depend on the query — pulled out
	//     of the per-keystroke path, a search costs 19 ms instead of 555 ms;
	//   • it runs only while the user is actually searching, so a history panel that is merely open
	//     pays nothing at all.
	return useMemo(() => {
		if (!query) { return null; }
		const hits = searchPrepared(prepareCached(threads), query);
		return new Map(hits.map(hit => [hit.threadId, hit]));
	}, [threads, query]);
}
