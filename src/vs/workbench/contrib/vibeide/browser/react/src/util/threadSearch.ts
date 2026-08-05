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
import { searchTranscripts, TranscriptHit, TranscriptThread } from '../../../../common/transcriptSearch.js';
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
 * Hits by thread id for the current query, or `null` while the query is empty — callers treat
 * `null` as "not filtering" rather than "nothing found", and the two must not be confused.
 *
 * Debounced inside: scanning every message of every thread on each keystroke is work nobody sees.
 */
export function useThreadSearch(threads: readonly ThreadType[], rawQuery: string): Map<string, TranscriptHit> | null {
	const query = useDebounced(rawQuery.trim(), SEARCH_DEBOUNCE_MS);
	return useMemo(() => {
		if (!query) { return null; }
		const hits = searchTranscripts(threads.map(toTranscriptThread), query);
		return new Map(hits.map(hit => [hit.threadId, hit]));
	}, [threads, query]);
}
