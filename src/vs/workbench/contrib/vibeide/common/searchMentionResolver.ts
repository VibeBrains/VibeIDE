/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for the `@search` mention (K.3 / 933).
 *
 * The mention service in `vibeMentionService.ts` recognises `@search:foo` and
 * `@search "foo bar"`. This module turns a list of grep hits into a deterministic
 * context fragment we feed back to the LLM — no embeddings, no LLM judging, just
 * literal matches with a fixed truncation budget.
 *
 * vscode-free: no imports beyond the standard library so this is unit-testable
 * end-to-end without a workbench harness.
 */

/**
 * One literal grep hit. Coordinates are 1-based to match Editor / Grep convention.
 * `lineText` is the raw matched line (no trimming) — caller decides whether to
 * pretty-print whitespace.
 */
export interface SearchHit {
	filePath: string;
	line: number;
	column?: number;
	lineText: string;
}

export interface SearchMentionRenderOptions {
	/** Hard cap on characters in the rendered fragment. Default 4 000. */
	maxChars?: number;
	/** Hard cap on hits to include. Default 30. */
	maxHits?: number;
	/** Cap on chars per single hit's `lineText`. Default 200. */
	maxHitChars?: number;
}

const DEFAULT_OPTIONS: Required<SearchMentionRenderOptions> = {
	maxChars: 4_000,
	maxHits: 30,
	maxHitChars: 200,
};

/**
 * Validate a search query before sending it to grep. Pure — does not touch FS.
 *
 * Rules:
 *   - non-empty after trim
 *   - no zero-width / Bidi-override characters (paste-time injection guard)
 *   - length ≤ 200 (regex DoS surface; grep itself rejects huge regex too)
 *
 * Returns a tagged result so the caller does not have to throw/catch.
 */
export function validateSearchQuery(raw: unknown): { ok: true; value: string } | { ok: false; reason: string } {
	if (typeof raw !== 'string') {
		return { ok: false, reason: 'query-not-a-string' };
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { ok: false, reason: 'query-empty' };
	}
	if (trimmed.length > 200) {
		return { ok: false, reason: 'query-too-long' };
	}
	// Zero-width chars (U+200B..U+200F, U+FEFF) and Bidi overrides
	// (U+202A..U+202E, U+2066..U+2069). Cheap upfront block — grep would
	// happily match them but they confuse the rendered context.
	if (/[​-‏﻿‪-‮⁦-⁩]/.test(trimmed)) {
		return { ok: false, reason: 'query-contains-invisible-chars' };
	}
	return { ok: true, value: trimmed };
}

/**
 * Produce the LLM-facing fragment for `@search:<query>`. Output is markdown:
 *
 *     ## @search results for "foo"
 *     - `src/util.ts:42`: `function foo() {`
 *     - `src/util.ts:88`: `  return foo + 1`
 *     ...
 *     _showing 2 of 2 hits_
 *
 * Empty hits → a single line "no matches" so the model knows the search ran
 * (silent empty answers cause the model to retry with `@web`).
 */
export function renderSearchMentionFragment(
	query: string,
	hits: ReadonlyArray<SearchHit>,
	options: SearchMentionRenderOptions = {},
): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const lines: string[] = [];
	lines.push(`## @search results for "${escapeMarkdown(query)}"`);

	if (hits.length === 0) {
		lines.push('_no matches in workspace (literal grep, no embeddings)_');
		return lines.join('\n');
	}

	let included = 0;
	let totalChars = lines[0].length;
	const cappedHits = hits.slice(0, opts.maxHits);
	for (const hit of cappedHits) {
		const trimmed = hit.lineText.length > opts.maxHitChars
			? hit.lineText.slice(0, opts.maxHitChars) + '…'
			: hit.lineText;
		const renderedLine = `- \`${hit.filePath}:${hit.line}\`: \`${escapeBackticks(trimmed)}\``;
		if (totalChars + renderedLine.length + 1 > opts.maxChars) {
			break;
		}
		lines.push(renderedLine);
		included++;
		totalChars += renderedLine.length + 1;
	}

	const omitted = hits.length - included;
	if (omitted > 0) {
		lines.push(`_showing ${included} of ${hits.length} hits (truncated for context budget)_`);
	} else {
		lines.push(`_showing ${included} of ${hits.length} hits_`);
	}

	return lines.join('\n');
}

function escapeMarkdown(s: string): string {
	return s.replace(/[\\`*_{}\[\]()#+\-!|]/g, c => '\\' + c);
}

function escapeBackticks(s: string): string {
	// Hits are wrapped in single backticks; replace inner backticks with a
	// non-rendering substitute so the markdown parser doesn't break the cell.
	return s.replace(/`/g, 'ˋ'); // ˋ MODIFIER LETTER GRAVE ACCENT
}
