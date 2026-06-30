/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Indentation alignment for SEARCH/REPLACE application.
 *
 * Why this exists: `edit_file` matches the search text against the file ignoring indentation
 * (line-trimmed fallback) but then inserts the replacement VERBATIM. When a model copies the
 * anchor without its leading whitespace (a very common normalization), the replacement lands at
 * the wrong column — and the model, seeing a ragged result, wrongly concludes the tool "trims"
 * its text and spirals retrying. This helper re-indents the replacement to the file's anchor only
 * when the match was NOT byte-exact (i.e. indentation genuinely differed).
 *
 * Two real-world shapes are handled distinctly:
 *   1. Consistent dedent  — the model wrote the WHOLE block dedented relative to the file
 *      (every replacement line shifted by the same amount). Fix: shift every line by the delta.
 *   2. First-line omission — the body is already at the file's indent level, only the first line
 *      lost its leading whitespace. Fix: re-indent ONLY the first line to the anchor.
 *
 * Pure (no I/O) so it is unit-testable from test/common.
 */

/**
 * True when index `idx` in `text` sits at the start of a line (start-of-text or right after a `\n`).
 *
 * Used to decide whether a raw `indexOf` hit is a real byte-exact LINE match. A hit that starts
 * mid-line (e.g. the model dropped the anchor's first-line indent, so the search text matches from
 * the middle of an indented line) is NOT line-aligned — the caller should treat it as inexact and
 * fall through to indentation-tolerant matching so the replacement gets re-indented.
 */
export function isAtLineStart(text: string, idx: number): boolean {
	return idx === 0 || text[idx - 1] === '\n';
}

/** Leading run of spaces/tabs of a single line (no newline expected). */
export function getLeadingWhitespace(line: string): string {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0] : '';
}

function setLineIndent(line: string, indent: string): string {
	return indent + line.slice(getLeadingWhitespace(line).length);
}

/**
 * Re-indent `finalText` so its baseline aligns with the file's matched anchor.
 *
 * @param searchIndent leading whitespace the model used on the anchor's first non-blank line
 * @param fileIndent   leading whitespace of that same line as it actually appears in the file
 * @param finalText    the replacement text (the model's `new_string`), verbatim
 * @returns the re-indented replacement, or `finalText` unchanged when no safe adjustment applies
 */
export function alignReplacementIndentation(searchIndent: string, fileIndent: string, finalText: string): string {
	if (searchIndent === fileIndent) { return finalText; }
	if (finalText.length === 0) { return finalText; }

	const lines = finalText.split('\n');

	// Locate the first non-blank line and measure the minimum indent of the remaining body lines.
	let firstIdx = -1;
	let bodyMin = Number.POSITIVE_INFINITY;
	let bodyCount = 0;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === '') { continue; }
		if (firstIdx === -1) { firstIdx = i; continue; }
		bodyCount++;
		bodyMin = Math.min(bodyMin, getLeadingWhitespace(lines[i]).length);
	}
	if (firstIdx === -1) { return finalText; } // only blank lines
	const firstIndentLen = getLeadingWhitespace(lines[firstIdx]).length;

	// Shape 2: ONLY the first line lost its indent — it is an outlier (less indented than the body)
	// while the body already sits exactly at the file's indent level. Snap just the first non-blank
	// line to the anchor, leave the body untouched. (Distinguishes from a uniform over/under-indent,
	// where the first line is consistent with the body and the whole block must shift.)
	if (bodyCount > 0 && firstIndentLen < bodyMin && bodyMin === fileIndent.length) {
		lines[firstIdx] = setLineIndent(lines[firstIdx], fileIndent);
		return lines.join('\n');
	}

	// Shape 1: consistent shift. Map the baseline searchIndent → fileIndent on every non-blank line.
	if (fileIndent.startsWith(searchIndent)) {
		const add = fileIndent.slice(searchIndent.length);
		return lines.map(l => l.trim() === '' ? l : add + l).join('\n');
	}
	if (searchIndent.startsWith(fileIndent)) {
		const remove = searchIndent.slice(fileIndent.length);
		const out = lines.map(l => l.startsWith(remove) ? l.slice(remove.length) : l);
		// A replacement line that did NOT carry the model's extra indent (e.g. the model indented its
		// search anchor but wrote the replacement's first line flush-left) is left untouched by the
		// dedent above — which would land it SHALLOWER than the file anchor (the observed "comment
		// snapped to column 0" bug). Snap the first non-blank line back to the file indent so the
		// replacement never sits left of where the anchor lives. Mirrors the first-line snap the
		// other fallbacks already apply; a line already at/deeper than the anchor is left as-is.
		if (getLeadingWhitespace(out[firstIdx]).length < fileIndent.length) {
			out[firstIdx] = setLineIndent(out[firstIdx], fileIndent);
		}
		return out.join('\n');
	}

	// Incompatible whitespace (e.g. tabs vs spaces, no prefix relation) → at minimum align the
	// first line to the anchor so the most common visible defect is fixed.
	lines[firstIdx] = setLineIndent(lines[firstIdx], fileIndent);
	return lines.join('\n');
}

/** First non-blank line of a multi-line string, or '' if none. */
export function firstNonBlankLine(text: string): string {
	for (const line of text.split('\n')) {
		if (line.trim() !== '') { return line; }
	}
	return '';
}
