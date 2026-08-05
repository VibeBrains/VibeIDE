/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Search over chat transcripts — the whole conversation, not just its opening line.
 *
 * WHY THIS EXISTS: history search compared the query against the FIRST user message only, so it
 * searched a title rather than a conversation. «В каком чате я разбирался с манглером» found
 * nothing whenever the phrase came up mid-discussion — which is where it usually comes up.
 *
 * Weights differ from documentation search on purpose. A transcript has no headings and no file
 * names; what it has is who said it and when. The user's own words rank highest because that is
 * how someone remembers a conversation — by what they asked, not by what the model answered.
 *
 * Pure: transcripts in, ranked hits out. No I/O and no model — the same lexical, offline,
 * deterministic contract as `docsSearch`, sharing its mechanics through `lexicalSearch`.
 */

import { buildExcerpt, countOccurrences, normalise, queryTerms } from './lexicalSearch.js';

/** One message as the search sees it — role and text, nothing else. */
export interface TranscriptMessage {
	readonly role: 'user' | 'assistant' | 'other';
	readonly text: string;
}

export interface TranscriptThread {
	readonly threadId: string;
	/** Sort key for tie-breaks: a newer conversation is the likelier answer to "where did I…". */
	readonly lastModified: number;
	readonly messages: readonly TranscriptMessage[];
}

export interface TranscriptHit {
	readonly threadId: string;
	readonly score: number;
	/** Text around the strongest match, so the row can show WHY the thread matched. */
	readonly excerpt: string;
	/** Who said the matching line — the row labels the excerpt with it. */
	readonly role: TranscriptMessage['role'];
	/** Index of the matching message, so a future "jump to it" has somewhere to go. */
	readonly messageIndex: number;
}

/**
 * A chat message is a short unit already; below this it is shown whole rather than cut. Larger
 * than the documentation threshold would be pointless here — a row in the history list has no
 * space for an essay, and the excerpt window is what the row can actually display.
 */
const FULL_MESSAGE_CHARS = 240;

/**
 * The opening message is the de-facto title of a thread: it is what the list already shows and
 * what the user is most likely to half-remember. A hit there outranks the same words said later.
 */
const WEIGHT_FIRST_MESSAGE = 12;
/** The user's own phrasing — how a conversation is remembered. */
const WEIGHT_USER = 6;
/** The model's answer still matters: an error text or a file name often appears only there. */
const WEIGHT_ASSISTANT = 2;
/** Synthetic nudges, gate notices and other machinery: searchable, but never the reason to rank. */
const WEIGHT_OTHER = 1;
/** Extra credit when every query term shows up somewhere in the thread. */
const WEIGHT_ALL_TERMS = 10;
/**
 * Saturation cap on occurrences of ONE term inside ONE message. Without it a single long message
 * repeating a word outranks a thread where the topic is actually discussed across turns.
 */
const MAX_HITS_PER_MESSAGE = 3;

function weightOf(message: TranscriptMessage, index: number): number {
	if (index === 0) { return WEIGHT_FIRST_MESSAGE; }
	switch (message.role) {
		case 'user': return WEIGHT_USER;
		case 'assistant': return WEIGHT_ASSISTANT;
		default: return WEIGHT_OTHER;
	}
}

/**
 * Ranks threads against a query. Threads matching nothing are omitted rather than returned with
 * score 0 — "not in this conversation" and "a weak match here" must stay distinguishable.
 *
 * `limit = 0` means "no limit": the history list filters rather than paginates, and cutting the
 * result would hide threads the user can see are there.
 */
export function searchTranscripts(threads: readonly TranscriptThread[], query: string, limit = 0): TranscriptHit[] {
	const terms = queryTerms(query);
	if (!terms.length) { return []; }

	const hits: TranscriptHit[] = [];
	for (const thread of threads) {
		let score = 0;
		const matchedTerms = new Set<string>();
		// Best single message, kept for the excerpt: the row shows one line, so it should be the
		// strongest one rather than whichever matched first.
		let bestMessageScore = 0;
		let bestIndex = -1;

		for (let index = 0; index < thread.messages.length; index++) {
			const message = thread.messages[index];
			const text = normalise(message.text);
			if (!text) { continue; }
			const weight = weightOf(message, index);

			let messageScore = 0;
			for (const term of terms) {
				const found = countOccurrences(text, term);
				if (!found) { continue; }
				matchedTerms.add(term);
				messageScore += Math.min(found, MAX_HITS_PER_MESSAGE) * weight;
			}
			if (!messageScore) { continue; }
			score += messageScore;
			if (messageScore > bestMessageScore) {
				bestMessageScore = messageScore;
				bestIndex = index;
			}
		}

		if (!score || bestIndex === -1) { continue; }
		if (matchedTerms.size === terms.length && terms.length > 1) { score += WEIGHT_ALL_TERMS; }

		const best = thread.messages[bestIndex];
		hits.push({
			threadId: thread.threadId,
			score,
			excerpt: buildExcerpt(best.text.trim(), terms, FULL_MESSAGE_CHARS),
			role: best.role,
			messageIndex: bestIndex,
		});
	}

	// Newer first on equal score: two conversations about the same thing are told apart by recency,
	// and threadId last keeps the order stable across identical runs.
	const byThread = new Map(threads.map(thread => [thread.threadId, thread.lastModified]));
	hits.sort((a, b) =>
		b.score - a.score
		|| (byThread.get(b.threadId) ?? 0) - (byThread.get(a.threadId) ?? 0)
		|| a.threadId.localeCompare(b.threadId));
	return limit > 0 ? hits.slice(0, limit) : hits;
}
