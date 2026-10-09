/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Two rankings of the same documents into one — Reciprocal Rank Fusion, pure
 *
 * Places are added, not scores: a BM25 score and a cosine live on different scales, and blending them needs a
 * normalisation that changes with every query. A document only one ranking found still gets in — the point of search
 * by meaning is to find the code that shares no word with the question
 */

/** The usual constant: damps the head so one ranking's first place does not outweigh agreement of both */
const RRF_K = 60;

/** Keys in fused order, best first; each input ranking is best first */
export function fuseRankings<T>(rankings: ReadonlyArray<readonly T[]>, keyOf: (item: T) => string): T[] {
	const score = new Map<string, number>();
	const first = new Map<string, T>();
	for (const ranking of rankings) {
		ranking.forEach((item, place) => {
			const key = keyOf(item);
			score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + place + 1));
			if (!first.has(key)) {
				first.set(key, item);
			}
		});
	}
	return [...first.keys()].sort((a, b) => score.get(b)! - score.get(a)!).map(key => first.get(key)!);
}
