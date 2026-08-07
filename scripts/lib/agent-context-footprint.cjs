/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// What the agent carries before the user has typed anything: project rules, skills, the manual
// bundle, the root instruction files. Every one of them is paid for on EVERY request, and the
// cost is invisible — a manual added today quietly taxes every run tomorrow.
//
// Pure functions here, file walking in the caller (scripts/vibe-doctor.js), so the thresholds
// and the arithmetic are testable without a repository.

/**
 * Characters per token, rough. Russian text in UTF-8 tokenises far worse than English (a
 * Cyrillic letter is commonly its own token or a two-byte fragment), and this project writes
 * user-facing docs in Russian — so a Latin-tuned 4.0 would understate the bill. Deliberately
 * conservative: the check exists to warn, and a warning that arrives too late is useless.
 */
const CHARS_PER_TOKEN = 2.5;

/** Warn above this share of a 200k-token window; below it the footprint is not worth a line. */
const WINDOW_TOKENS = 200000;
const WARN_SHARE = 0.05;

/** Categories of always-on context, in the order a reader cares about them. */
const CATEGORIES = ['rules', 'skills', 'manuals', 'instructions'];

/** Rough token estimate for a character count. */
function estimateTokens(chars) {
	return Math.round(chars / CHARS_PER_TOKEN);
}

/**
 * Folds per-file measurements into a report.
 *
 * `files` — array of `{ category, path, chars }`. Unknown categories are kept rather than
 * dropped: silently losing a category would understate the total, which is the one number this
 * check exists to be honest about.
 */
function summariseContextFootprint(files) {
	const byCategory = new Map();
	for (const file of files) {
		const entry = byCategory.get(file.category) || { category: file.category, files: 0, chars: 0, largest: undefined };
		entry.files += 1;
		entry.chars += file.chars;
		if (!entry.largest || file.chars > entry.largest.chars) {
			entry.largest = { path: file.path, chars: file.chars };
		}
		byCategory.set(file.category, entry);
	}

	const known = CATEGORIES.filter(c => byCategory.has(c));
	const extra = [...byCategory.keys()].filter(c => !CATEGORIES.includes(c)).sort();
	const categories = [...known, ...extra].map(c => {
		const entry = byCategory.get(c);
		return { ...entry, tokens: estimateTokens(entry.chars) };
	});

	const chars = categories.reduce((sum, c) => sum + c.chars, 0);
	const tokens = estimateTokens(chars);
	return {
		chars,
		tokens,
		share: tokens / WINDOW_TOKENS,
		categories,
		windowTokens: WINDOW_TOKENS,
	};
}

/**
 * One line for the doctor. Returns `null` when the footprint is small enough to say nothing —
 * a check that always talks is a check people stop reading.
 */
function describeContextFootprint(report) {
	if (!report.categories.length) {
		return null;
	}
	const parts = report.categories
		.filter(c => c.tokens > 0)
		.map(c => `${c.category} ~${c.tokens} tok (${c.files})`);
	const head = `always-on context ~${report.tokens} tok (${Math.round(report.share * 100)}% of ${report.windowTokens / 1000}k)`;
	if (report.share < WARN_SHARE) {
		return { level: 'ok', message: `${head}: ${parts.join(', ')}` };
	}
	const biggest = report.categories.reduce((max, c) => (max && max.tokens >= c.tokens ? max : c), undefined);
	const hint = biggest && biggest.largest
		? ` — largest single file: ${biggest.largest.path} (~${estimateTokens(biggest.largest.chars)} tok)`
		: '';
	return { level: 'warning', message: `${head}: ${parts.join(', ')}${hint}` };
}

module.exports = {
	CHARS_PER_TOKEN,
	WINDOW_TOKENS,
	WARN_SHARE,
	estimateTokens,
	summariseContextFootprint,
	describeContextFootprint,
};
