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

import { buildExcerpt, countOccurrences, normalise, queryTerms } from './lexicalSearch.js';

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

/**
 * Sections at or under this size are returned IN FULL instead of excerpted.
 *
 * Measured on the real corpus: 86 of 140 sections are longer than the excerpt window, and the
 * first live run failed on exactly that — the model found the spec's field table, received 320
 * characters of it, and had to answer "the table is not available to me". A section is already
 * the author's unit of meaning; cutting it mid-table serves nobody. 2500 covers the 90th
 * percentile (1315 chars) with room to spare, while still capping the handful of sprawling ones.
 */
const FULL_SECTION_CHARS = 2500;

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
 * Saturation cap on body occurrences of ONE term. Without it a long section wins on bulk alone:
 * measured on the real corpus, the sprawling «Vibe Server» entry in `functional.md` outranked the
 * design manual's own section for "дизайн детектор превью" purely because it is longer. Mentioning
 * a term five times does not make a section five times more relevant — the third mention already
 * settles that the topic is there.
 */
const MAX_BODY_HITS_PER_TERM = 3;

export { queryTerms };

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
		// A heading with no prose of its own is a container — its content lives in the child
		// sections, which are indexed separately. Returning it would spend a slot on an empty
		// citation, which is how the first live run ended up with "the table is not available
		// to me" while the table sat one heading below.
		if (!section.body) { continue; }
		if (matched === terms.length && terms.length > 1) { score += WEIGHT_ALL_TERMS; }

		hits.push({ section, score, excerpt: buildExcerpt(section.body, terms, FULL_SECTION_CHARS) });
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
