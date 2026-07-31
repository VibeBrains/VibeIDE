/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure decision logic for V8 code-cache pruning (used by CodeCacheCleaner).
 *
 * Kept import-free so the policy is unit-testable without the shared-process /
 * Electron harness. The cleaner does the IO (readdir/stat/rm); this only decides
 * WHICH commit-named cache folders to delete.
 *
 * Two independent triggers, deleting a folder if EITHER fires:
 *   1. Age — older than `maxAgeMs` (the upstream behaviour, derived from quality).
 *   2. Count — beyond the `keepMostRecent` newest folders. This bounds accumulation
 *      for local-dev rebuild loops, where every rebuild mints a fresh commit-named
 *      cache folder that the age trigger never reaches (all younger than the window),
 *      so a week of frequent rebuilds piled up unboundedly (roadmap 3159, safe branch:
 *      bound retention explicitly instead of relying on a `quality` value that is
 *      undefined in this fork — which silently selected the 1-week window).
 *
 * The current cache folder is NEVER selected. Non-directory entries are ignored.
 */

export interface CodeCacheEntry {
	readonly name: string;
	/** Last-modified time in ms epoch (folder mtime). */
	readonly mtimeMs: number;
	readonly isDirectory: boolean;
}

export interface CodeCachePruneOptions {
	/** Name of the in-use cache folder — never deleted. */
	readonly currentCacheName: string;
	/** Current time, ms epoch. */
	readonly now: number;
	/** Delete folders older than this many ms. */
	readonly maxAgeMs: number;
	/** Keep at most this many newest folders (in addition to the age rule). Clamped to ≥1. */
	readonly keepMostRecent: number;
}

/**
 * Returns the names of cache folders to delete. Order is newest-first among the
 * surviving set is irrelevant to callers — they just rm each returned name.
 */
export function selectCodeCachesToDelete(entries: readonly CodeCacheEntry[], opts: CodeCachePruneOptions): string[] {
	const keep = Math.max(1, Math.floor(opts.keepMostRecent));
	const candidates = entries
		.filter(e => e.isDirectory && e.name !== opts.currentCacheName)
		// Newest first, so index >= keep marks the surplus-by-count folders.
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const toDelete: string[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const e = candidates[i];
		const tooOld = (opts.now - e.mtimeMs) > opts.maxAgeMs;
		const surplusByCount = i >= keep;
		if (tooOld || surplusByCount) {
			toDelete.push(e.name);
		}
	}
	return toDelete;
}
