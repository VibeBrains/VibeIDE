/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tolerant line-based matching for SEARCH/REPLACE apply. Weaker models (minimax-class via
 * aggregators) reproduce the text to replace ALMOST verbatim — right content, but drifted
 * indentation, trailing whitespace, or a slightly paraphrased middle. Byte-exact matching then
 * fails and the model spirals into throwaway scripts. This module forgives near-misses the way
 * OpenCode / Kilo / Roo do (line-trimmed + block-anchor with a Levenshtein-scored middle), so the
 * model only has to get the snippet APPROXIMATELY right.
 *
 * Pure (no I/O, no VS Code deps) → unit-testable from test/common/. Returns a 1-indexed inclusive
 * line range, or a reason string. Span size is bounded (line-trimmed = exact line count;
 * block-anchor = ±25%), so a fuzzy match can never silently eat a large unrelated region.
 */

export type LineRange = readonly [number, number]; // 1-indexed, inclusive
export type LineMatchOutcome = LineRange | 'not-found' | 'not-unique';

const norm = (s: string): string => s.trim();

/** Levenshtein distance with a size guard — falls back to a coarse line-overlap ratio when the
 *  inputs are large, so we never run O(n·m) DP on huge middles. */
function similarity(a: string, b: string): number {
	if (a === b) { return 1; }
	if (a.length === 0 || b.length === 0) { return a.length === b.length ? 1 : 0; }
	const maxLen = Math.max(a.length, b.length);
	if (maxLen > 2000) {
		// Coarse fallback: ratio of matching trimmed lines.
		const al = a.split('\n'), bl = b.split('\n');
		const n = Math.max(al.length, bl.length);
		let same = 0;
		for (let i = 0; i < Math.min(al.length, bl.length); i++) { if (al[i].trim() === bl[i].trim()) { same++; } }
		return n === 0 ? 1 : same / n;
	}
	// Standard two-row DP Levenshtein.
	let prev = new Array(b.length + 1);
	let curr = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) { prev[j] = j; }
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	return 1 - prev[b.length] / maxLen;
}

/** Strategy 1 — line-trimmed: every search line must equal a file line after `.trim()`. Same line
 *  count. Handles indentation / trailing-whitespace drift. Requires a UNIQUE match. */
function lineTrimmedMatch(searchLines: readonly string[], fileLines: readonly string[], fromIdx: number): LineMatchOutcome {
	const n = searchLines.length;
	if (n === 0) { return 'not-found'; }
	const searchNorm = searchLines.map(norm);
	const matches: number[] = [];
	for (let i = fromIdx; i + n <= fileLines.length; i++) {
		let ok = true;
		for (let j = 0; j < n; j++) {
			if (norm(fileLines[i + j]) !== searchNorm[j]) { ok = false; break; }
		}
		if (ok) { matches.push(i); }
	}
	if (matches.length === 0) { return 'not-found'; }
	if (matches.length > 1) { return 'not-unique'; }
	return [matches[0] + 1, matches[0] + n] as const;
}

/** Strategy 2 — block-anchor: for blocks ≥3 lines, first & last lines (trimmed) anchor the span;
 *  the middle is scored by Levenshtein similarity. Tolerates a paraphrased / slightly-off middle
 *  and ±25% block-size drift. Accepts the best span ≥ `threshold`; ambiguous ties → not-unique. */
function blockAnchorMatch(searchLines: readonly string[], fileLines: readonly string[], fromIdx: number, threshold = 0.5): LineMatchOutcome {
	const n = searchLines.length;
	if (n < 3) { return 'not-found'; }
	const first = norm(searchLines[0]);
	const last = norm(searchLines[n - 1]);
	const maxDelta = Math.max(1, Math.floor(n * 0.25));
	const searchMid = searchLines.slice(1, n - 1).map(norm).join('\n');

	const candidates: { start: number; end: number; score: number }[] = [];
	for (let i = fromIdx; i < fileLines.length; i++) {
		if (norm(fileLines[i]) !== first) { continue; }
		for (let len = n - maxDelta; len <= n + maxDelta; len++) {
			const endIdx = i + len - 1;
			if (len < 2 || endIdx >= fileLines.length || endIdx <= i) { continue; }
			if (norm(fileLines[endIdx]) !== last) { continue; }
			const fileMid = fileLines.slice(i + 1, endIdx).map(norm).join('\n');
			candidates.push({ start: i, end: endIdx, score: similarity(searchMid, fileMid) });
		}
	}
	if (candidates.length === 0) { return 'not-found'; }
	candidates.sort((a, b) => b.score - a.score);
	const best = candidates[0];
	if (best.score < threshold) { return 'not-found'; }
	// Ambiguous only if a DIFFERENT span ties the top score.
	if (candidates.length > 1 && candidates[1].score === best.score && candidates[1].start !== best.start) { return 'not-unique'; }
	return [best.start + 1, best.end + 1] as const;
}

/**
 * Find `searchText` in `fileContents` tolerantly. Tries line-trimmed first, then block-anchor.
 * `fromLine` (1-indexed) optionally restricts the search to at/after that line. Returns a 1-indexed
 * inclusive line range, or 'not-found' / 'not-unique'.
 */
export function findLinesTolerant(searchText: string, fileContents: string, fromLine?: number): LineMatchOutcome {
	const fileLines = fileContents.split('\n');
	let searchLines = searchText.split('\n');
	// Search text commonly ends with a newline → a trailing empty element. Drop one so line counts align.
	if (searchLines.length > 1 && searchLines[searchLines.length - 1] === '') { searchLines = searchLines.slice(0, -1); }
	if (searchLines.length === 0) { return 'not-found'; }
	const fromIdx = fromLine && fromLine > 1 ? fromLine - 1 : 0;

	const trimmed = lineTrimmedMatch(searchLines, fileLines, fromIdx);
	if (trimmed !== 'not-found') { return trimmed; }
	return blockAnchorMatch(searchLines, fileLines, fromIdx);
}
