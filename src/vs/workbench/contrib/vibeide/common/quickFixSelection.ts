/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Choosing which of the editor's own quick fixes can be applied together.
 *
 * After the agent edits a file we collect markers and hand them to the model, which then spends
 * tokens fixing things the editor already knows how to fix deterministically and for free — a
 * missing import being the classic case. Applying them first, and telling the model what was
 * applied, is strictly cheaper.
 *
 * The catch is that quick fixes are proposed per marker, independently. Two of them can touch the
 * same lines (one marker's "add import" and another's "organise imports"), and applying both in one
 * batch produces garbage. This module picks a batch that cannot conflict: pure ranges in, pure
 * decision out, testable without a text model.
 */

/** A zero-based-agnostic range, matching Monaco's 1-based line/column convention. */
export interface EditRange {
	readonly startLineNumber: number;
	readonly startColumn: number;
	readonly endLineNumber: number;
	readonly endColumn: number;
}

export interface CandidateFix<TEdit extends { readonly range: EditRange }> {
	readonly title: string;
	readonly edits: readonly TEdit[];
}

function isEmpty(range: EditRange): boolean {
	return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn;
}

/** Position `p` lies within `range`, both bounds included. */
function containsInclusive(range: EditRange, line: number, column: number): boolean {
	const afterStart = line > range.startLineNumber || (line === range.startLineNumber && column >= range.startColumn);
	const beforeEnd = line < range.endLineNumber || (line === range.endLineNumber && column <= range.endColumn);
	return afterStart && beforeEnd;
}

/**
 * True when two edits cannot be applied together.
 *
 * Touching endpoints of two replacements are fine — they are adjacent, not competing. An **empty**
 * range is different: it is an insertion point, and an insertion sitting anywhere inside another
 * edit's range (its boundaries included) collides with it. That case is not theoretical — "add
 * import" inserts at 1:1 while "organise imports" rewrites lines 1–2, and applying both duplicates
 * the import. Treating the insertion as "ends before" the rewrite is what let both through.
 */
export function rangesOverlap(a: EditRange, b: EditRange): boolean {
	if (isEmpty(a)) {
		return containsInclusive(b, a.startLineNumber, a.startColumn);
	}
	if (isEmpty(b)) {
		return containsInclusive(a, b.startLineNumber, b.startColumn);
	}
	const aEndsBeforeB = a.endLineNumber < b.startLineNumber
		|| (a.endLineNumber === b.startLineNumber && a.endColumn <= b.startColumn);
	const bEndsBeforeA = b.endLineNumber < a.startLineNumber
		|| (b.endLineNumber === a.startLineNumber && b.endColumn <= a.startColumn);
	return !aEndsBeforeB && !bEndsBeforeA;
}

/**
 * Take fixes in the given order, keeping each one only if none of its edits touch a range already
 * claimed. Order matters and is the caller's: the editor lists its preferred fix first, so
 * first-come-first-served keeps the better fix and drops the one that would have fought it.
 */
export function selectCompatibleFixes<TEdit extends { readonly range: EditRange }>(
	candidates: readonly CandidateFix<TEdit>[],
): CandidateFix<TEdit>[] {
	const claimed: EditRange[] = [];
	const chosen: CandidateFix<TEdit>[] = [];
	for (const candidate of candidates) {
		if (candidate.edits.length === 0) {
			continue;
		}
		const conflicts = candidate.edits.some(edit => claimed.some(range => rangesOverlap(range, edit.range)));
		if (conflicts) {
			continue;
		}
		for (const edit of candidate.edits) {
			claimed.push(edit.range);
		}
		chosen.push(candidate);
	}
	return chosen;
}
