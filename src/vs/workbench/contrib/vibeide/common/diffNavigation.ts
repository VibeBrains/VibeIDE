/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which change becomes current after one was accepted or rejected
 *
 * The one that followed the resolved change takes the turn, after the last one — the one before it
 * Whatever was current before does not matter: the reader is where they just clicked, and that is where they continue
 * Positions are used, not ids: every refresh rebuilds the changes of a file with new ids
 *
 * @param resolvedIdx where the resolved change stood in the list before the resolve
 * @param newLength how many changes are left
 */
export function diffIdxAfterResolve(resolvedIdx: number, newLength: number): number | null {
	return newLength === 0 ? null : Math.min(resolvedIdx, newLength - 1);
}
