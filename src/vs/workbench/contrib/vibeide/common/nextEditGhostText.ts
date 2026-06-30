/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Next-edit ghost-text builder (1029) — pure helper.
 *
 * `cursorJumpThemeDetector.ts` returns a ThemeSignal when the user has
 * made N consecutive edits with the same theme (rename, signature
 * change). This module turns the signal + a candidate jump location into
 * the ghost-text string the editor renders for the Tab-to-next-edit
 * suggestion.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface JumpCandidate {
	/** File where the next edit is predicted. */
	uri: string;
	/** 1-based line number. */
	line: number;
	/** The text to replace (e.g. the old identifier on this line). */
	matchText: string;
	/** Optional surrounding line content for the preview (no ghost in the editor). */
	lineContext?: string;
}

export type ThemeSignal =
	| { kind: 'rename'; subject: string; subjectReplacement?: string }
	| { kind: 'signature-change'; subject: string };

export interface GhostTextBuild {
	/** The string to insert as ghost text at the jump location. Empty if no
	 * suggestion should be shown (theme + candidate didn't compose). */
	ghostText: string;
	/** 1-based start column where the ghost text replaces (`matchText.length` chars). */
	startColumn?: number;
	/** Short label for the keybinding hint (e.g. "Next rename"). */
	hintLabel: string;
}

/**
 * Build the ghost-text payload. Pure.
 *
 * Rename: replace `subject` with `subjectReplacement` at the candidate's
 * matchText location. The ghost text shown in the editor is the
 * replacement; the user accepts via Tab.
 *
 * Signature-change: ghost text is empty (the next "rename" idea doesn't
 * apply here). The hint label still surfaces so the user knows the
 * next-edit predictor is active; the editor highlights the candidate
 * line with a gutter icon instead of inline ghost text.
 */
export function buildNextEditGhostText(
	theme: ThemeSignal,
	candidate: JumpCandidate,
): GhostTextBuild {
	if (theme.kind === 'rename') {
		const replacement = theme.subjectReplacement ?? '';
		if (replacement.length === 0 || candidate.matchText !== theme.subject) {
			return { ghostText: '', hintLabel: '' };
		}
		return {
			ghostText: replacement,
			startColumn: 1,
			hintLabel: `Next rename → ${replacement}`,
		};
	}
	if (theme.kind === 'signature-change') {
		return { ghostText: '', hintLabel: `Next call site of \`${theme.subject}\`` };
	}
	return { ghostText: '', hintLabel: '' };
}

/**
 * Score a candidate for relevance. Pure. Lower score wins (ranking is
 * "closest to recently-touched files first"). Returns Infinity when the
 * candidate disqualifies (e.g. uri matches an excluded path).
 */
export function scoreJumpCandidate(
	candidate: JumpCandidate,
	recentlyTouchedUris: ReadonlyArray<string>,
	excludedUris: ReadonlySet<string> = new Set(),
): number {
	if (excludedUris.has(candidate.uri)) { return Infinity; }
	const idx = recentlyTouchedUris.indexOf(candidate.uri);
	if (idx >= 0) { return idx; }
	return recentlyTouchedUris.length + candidate.line;
}

/**
 * Pick the best candidate from a list. Pure.
 *
 * Returns `undefined` when the list is empty or every candidate is
 * disqualified (Infinity score). Stable ordering: tied scores break by
 * uri then line.
 */
export function pickBestJumpCandidate(
	candidates: ReadonlyArray<JumpCandidate>,
	recentlyTouchedUris: ReadonlyArray<string>,
	excludedUris: ReadonlySet<string> = new Set(),
): JumpCandidate | undefined {
	let best: JumpCandidate | undefined;
	let bestScore = Infinity;
	for (const c of candidates) {
		const s = scoreJumpCandidate(c, recentlyTouchedUris, excludedUris);
		if (s < bestScore || (s === bestScore && best && (c.uri < best.uri || (c.uri === best.uri && c.line < best.line)))) {
			best = c;
			bestScore = s;
		}
	}
	return bestScore === Infinity ? undefined : best;
}
