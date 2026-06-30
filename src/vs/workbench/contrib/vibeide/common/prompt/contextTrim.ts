/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure selection step of the context-trim pipeline (D.16 regression guard).
 *
 * Given the per-message trim weights, return the index of the heaviest message that is
 * actually trimmable, or -1 if none is. A weight of 0 means "MUST NOT be trimmed" — the
 * `weight()` function returns 0 for pinned context (workspace guidelines / system) and for
 * the freshest assistant↔tool exchange. Weights are never negative (length × non-negative
 * multiplier).
 *
 * D.16 bug this locks down: the old inline scan seeded the running max at `-Infinity`, so when
 * EVERY message was weight 0 (e.g. a huge pinned tool result + the pinned system, both over
 * budget) the first element's `0 > -Infinity` selected index 0 — the SYSTEM — and the trim loop
 * chopped it to TRIM_TO_LEN (37111→120 system-prompt collapse). Seeding at 0 means a zero-weight
 * message is never selected; if nothing is trimmable, the caller gets -1 and must stop rather
 * than crush pinned content.
 */
export function pickHeaviestTrimmableIndex(weights: readonly number[]): number {
	let largestIndex = -1;
	let largestWeight = 0; // 0 = pinned/empty → never a trim target
	for (let i = 0; i < weights.length; i++) {
		if (weights[i] > largestWeight) {
			largestWeight = weights[i];
			largestIndex = i;
		}
	}
	return largestIndex;
}
