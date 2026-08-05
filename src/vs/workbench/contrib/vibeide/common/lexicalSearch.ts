/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Lexical matching shared by everything VibeIDE searches without a model: normalisation, query
 * terms, occurrence counting, excerpting.
 *
 * Extracted from `docsSearch` when chat transcripts needed the same machinery. What is NOT here is
 * scoring: documentation ranks by heading and file name, a transcript by who said it and when, and
 * a shared weight table would have to lie about one of them. Mechanics travel, weights do not.
 *
 * Pure: strings in, strings out. No I/O, no model, no network — deterministic and offline.
 */

/**
 * Terms shorter than this are dropped: single letters and stray particles match everything and
 * only add noise. Two characters is short enough to keep meaningful queries ("m3", "ui").
 */
const MIN_TERM_LENGTH = 2;

/** Excerpt width for bodies too long to hand over whole. */
export const EXCERPT_CHARS = 320;

/** Normalises for matching: lowercase, punctuation to spaces, collapsed whitespace. */
export const normalise = (text: string): string =>
	text.toLowerCase().replace(/[^\p{L}\p{N}_.-]+/gu, ' ').replace(/\s+/g, ' ').trim();

/** Query terms, deduplicated and stripped of noise-length fragments. */
export function queryTerms(query: string): string[] {
	const seen = new Set<string>();
	for (const term of normalise(query).split(' ')) {
		if (term.length >= MIN_TERM_LENGTH) { seen.add(term); }
	}
	return [...seen];
}

/** Counts non-overlapping occurrences of `term` in already-normalised `haystack`. */
export const countOccurrences = (haystack: string, term: string): number => {
	if (!term) { return 0; }
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(term, from);
		if (at === -1) { return count; }
		count++;
		from = at + term.length;
	}
};

/**
 * Excerpt centred on the first matching term, snapped to word boundaries where possible.
 *
 * `fullBelow` is the size at or under which the text is returned INTACT: the caller knows what its
 * unit of meaning is. A documentation section is an author's table or step list and loses its
 * point when cut mid-row; a chat message is usually short enough to show whole anyway.
 */
export function buildExcerpt(body: string, terms: readonly string[], fullBelow: number): string {
	if (!body) { return ''; }
	if (body.length <= fullBelow) { return body; }
	const lower = body.toLowerCase();
	let at = -1;
	for (const term of terms) {
		const found = lower.indexOf(term);
		if (found !== -1 && (at === -1 || found < at)) { at = found; }
	}
	if (at === -1) { return body.slice(0, EXCERPT_CHARS).trim(); }

	const half = Math.floor(EXCERPT_CHARS / 2);
	let start = Math.max(0, at - half);
	let end = Math.min(body.length, start + EXCERPT_CHARS);
	// Snap to word boundaries so the excerpt does not begin mid-word.
	if (start > 0) {
		const space = body.indexOf(' ', start);
		if (space !== -1 && space - start < 40) { start = space + 1; }
	}
	if (end < body.length) {
		const space = body.lastIndexOf(' ', end);
		if (space > start && end - space < 40) { end = space; }
	}
	return (start > 0 ? '…' : '') + body.slice(start, end).trim() + (end < body.length ? '…' : '');
}
