/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Search over VibeIDE's own documentation, shipped inside the build.
 *
 * WHY THIS EXISTS: the agent could not use features this product already had. Asked to create
 * `.vibe/servers.json` it did not know the format (it lives in TypeScript types it will not open
 * on its own), went looking on GitHub and found nothing. Same story with the design detector: the
 * catalogue listed 55 checks but never said an open preview is the precondition. Documentation the
 * agent cannot reach is documentation that does not exist — see the global rule "фича с форматом
 * обязана иметь спеку и пример".
 *
 * Deliberately NOT a model call and NOT a network call: lexical, deterministic, works offline, and
 * matches the version actually installed rather than whatever `main` looks like today.
 *
 * Pure layer: chunking + ranking only. Reading the bundled files happens in the service, so this
 * stays testable from `test/common/` without a filesystem.
 */

/** One indexed section: a heading and the prose under it, up to the next heading of any level. */
export interface DocsSection {
	/** Path as published, e.g. `manuals/serversSpec.md` — what a citation should show. */
	readonly file: string;
	/** Heading text without the `#` markers. Empty for the preamble before the first heading. */
	readonly heading: string;
	/** Heading depth (1 for `#`, 2 for `##`…). `0` for the preamble. */
	readonly level: number;
	/** Section body, headings excluded. */
	readonly body: string;
	/** 1-based line where the heading sits — lets a citation point at the exact spot. */
	readonly line: number;
}

export interface DocsSearchHit {
	readonly section: DocsSection;
	readonly score: number;
	/** Body excerpt around the strongest match, for showing without dumping the section. */
	readonly excerpt: string;
}

/** Excerpt width; enough for a sentence or two of context around the hit. */
const EXCERPT_CHARS = 320;

/**
 * Scoring weights. A hit in the heading outranks a hit in prose because headings are what the
 * author chose to name the topic — searching "servers.json" should surface the spec's own section
 * before a passing mention elsewhere.
 */
// 20 rather than 12: tuned against the real corpus. At 12 a passing mention of «servers.json» in
// the feature catalogue outranked the spec's own heading, because a section mentioning every query
// term collects the all-terms bonus. A term IN THE HEADING is the strongest signal there is — the
// author named the section that — so it has to outweigh that bonus on its own.
const WEIGHT_HEADING = 20;
const WEIGHT_FILENAME = 8;
const WEIGHT_BODY = 1;
/** Extra credit when every query term appears in the same section — a partial match is weaker. */
const WEIGHT_ALL_TERMS = 15;

/**
 * Terms shorter than this are dropped: single letters and stray particles match everything and
 * only add noise. Two characters is short enough to keep meaningful queries ("m3", "ui").
 */
const MIN_TERM_LENGTH = 2;

/**
 * Saturation cap on body occurrences of ONE term. Without it a long section wins on bulk alone:
 * measured on the real corpus, the sprawling «Vibe Server» entry in `functional.md` outranked the
 * design manual's own section for "дизайн детектор превью" purely because it is longer. Mentioning
 * a term five times does not make a section five times more relevant — the third mention already
 * settles that the topic is there.
 */
const MAX_BODY_HITS_PER_TERM = 3;

/** Splits a markdown document into heading-scoped sections. */
export function splitIntoSections(file: string, content: string): DocsSection[] {
	const lines = content.split('\n');
	const sections: DocsSection[] = [];
	let heading = '';
	let level = 0;
	let headingLine = 1;
	let body: string[] = [];

	const flush = () => {
		const text = body.join('\n').trim();
		// A heading with no prose under it still matters — it is a navigable anchor.
		if (text || heading) {
			sections.push({ file, heading, level, body: text, line: headingLine });
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const match = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
		if (match) {
			flush();
			level = match[1].length;
			heading = match[2].trim();
			headingLine = i + 1;
			body = [];
		} else {
			body.push(lines[i]);
		}
	}
	flush();
	return sections;
}

/** Normalises for matching: lowercase, punctuation to spaces, collapsed whitespace. */
const normalise = (text: string): string =>
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
const countOccurrences = (haystack: string, term: string): number => {
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

/** Builds an excerpt centred on the first matching term, on word boundaries where possible. */
function buildExcerpt(body: string, terms: readonly string[]): string {
	if (!body) { return ''; }
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

/**
 * Ranks sections against a query. Returns at most `limit` hits, best first; sections matching
 * nothing are omitted entirely rather than returned with score 0 — "no answer here" and "here is
 * a bad answer" are different, and the caller should be able to tell them apart.
 */
export function searchDocs(sections: readonly DocsSection[], query: string, limit = 5): DocsSearchHit[] {
	const terms = queryTerms(query);
	if (!terms.length) { return []; }

	const hits: DocsSearchHit[] = [];
	for (const section of sections) {
		const headingText = normalise(section.heading);
		const fileText = normalise(section.file);
		const bodyText = normalise(section.body);

		let score = 0;
		let matched = 0;
		for (const term of terms) {
			const inHeading = countOccurrences(headingText, term);
			const inFile = countOccurrences(fileText, term);
			const inBody = countOccurrences(bodyText, term);
			if (inHeading || inFile || inBody) { matched++; }
			score += inHeading * WEIGHT_HEADING
				+ inFile * WEIGHT_FILENAME
				+ Math.min(inBody, MAX_BODY_HITS_PER_TERM) * WEIGHT_BODY;
		}
		if (!score) { continue; }
		if (matched === terms.length && terms.length > 1) { score += WEIGHT_ALL_TERMS; }

		hits.push({ section, score, excerpt: buildExcerpt(section.body, terms) });
	}

	// Ties broken by shallower heading first (a top-level section is the better landing spot),
	// then by file path — so repeated runs of the same query return the same order.
	hits.sort((a, b) =>
		b.score - a.score
		|| a.section.level - b.section.level
		|| a.section.file.localeCompare(b.section.file)
		|| a.section.line - b.section.line);
	return hits.slice(0, limit);
}

/** Renders hits as the compact citation block handed to a model or shown in the UI. */
export function formatHits(hits: readonly DocsSearchHit[]): string {
	if (!hits.length) { return ''; }
	return hits
		.map(h => {
			const where = h.section.heading ? `${h.section.file} › ${h.section.heading}` : h.section.file;
			return `**${where}** (строка ${h.section.line})\n${h.excerpt}`;
		})
		.join('\n\n');
}
