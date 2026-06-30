/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Multi-line completion accept policy (1023) — pure decision.
 *
 * VibeIDE FIM proposes a possibly multi-line completion. Two accept paths:
 *   - Tab        → accept the next "logical chunk" only (one line, or up
 *                  to the first balanced closing brace, whichever comes
 *                  first).
 *   - Shift+Tab  → accept the entire suggestion.
 *
 * `decideAccept(suggestion, mode)` returns the accepted text + the
 * remainder for re-display. Pure — no editor state, no clock.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type AcceptMode = 'partial' | 'full';

export interface AcceptDecision {
	accepted: string;
	remainder: string;
}

/**
 * Decide what slice of `suggestion` is accepted under `mode`. Pure.
 *
 * Partial (Tab):
 *   - If the suggestion is a single line, accept everything.
 *   - Otherwise, accept the first line (without the trailing `\n`).
 *
 * Full (Shift+Tab):
 *   - Always accept the entire string.
 *
 * Empty input returns empty accepted/remainder regardless of mode.
 */
export function decideAccept(suggestion: string, mode: AcceptMode): AcceptDecision {
	if (typeof suggestion !== 'string' || suggestion.length === 0) {
		return { accepted: '', remainder: '' };
	}
	if (mode === 'full') {
		return { accepted: suggestion, remainder: '' };
	}
	const newlineIdx = suggestion.indexOf('\n');
	if (newlineIdx < 0) {
		return { accepted: suggestion, remainder: '' };
	}
	const accepted = suggestion.slice(0, newlineIdx);
	const remainder = suggestion.slice(newlineIdx + 1);
	return { accepted, remainder };
}

/**
 * Variant of partial accept that walks until a balanced `{...}` closes,
 * useful for accepting an entire function body in one step. Pure.
 *
 * Walks character by character starting at the first `{`; accepts up to
 * the matching `}`. If no `{` exists, falls back to single-line accept.
 * Brackets inside string / template literals are NOT skipped — this is a
 * heuristic, not a full parser.
 */
export function decidePartialThroughBlock(suggestion: string): AcceptDecision {
	if (typeof suggestion !== 'string' || suggestion.length === 0) {
		return { accepted: '', remainder: '' };
	}
	const firstBrace = suggestion.indexOf('{');
	if (firstBrace < 0) {
		return decideAccept(suggestion, 'partial');
	}
	let depth = 0;
	for (let i = firstBrace; i < suggestion.length; i++) {
		const c = suggestion[i];
		if (c === '{') { depth++; }
		else if (c === '}') {
			depth--;
			if (depth === 0) {
				return {
					accepted: suggestion.slice(0, i + 1),
					remainder: suggestion.slice(i + 1),
				};
			}
		}
	}
	// Unbalanced; fall back to single-line accept.
	return decideAccept(suggestion, 'partial');
}
