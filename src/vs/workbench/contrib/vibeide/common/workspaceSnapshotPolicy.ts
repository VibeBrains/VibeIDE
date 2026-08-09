/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Working-tree snapshots for checkpoints.
 *
 * Checkpoints record file contents that passed through `editCodeService` — the agent's own edits.
 * Anything that changed the tree another way is invisible to them: a build script, `git checkout`,
 * a `sed` the agent ran in the terminal. Rolling back to such a checkpoint restores the files it
 * knows and silently leaves the rest, which is worse than not rolling back at all, because the
 * result looks like a clean restore.
 *
 * The snapshot is a git tree object written through a **temporary index**, so the user's real index
 * (staged changes) is never touched. `git stash create` was rejected: it does not capture untracked
 * files, and untracked output is precisely what terminal work produces.
 *
 * This module is pure — it builds argument vectors and decides what a restore would do. The process
 * spawning lives in the main-process service; the decisions live here so they are testable.
 */

/** Files git reports, split by how the restore must treat them. */
export interface SnapshotRestorePlan {
	/** Paths present in the snapshot: overwritten from it. */
	readonly restore: readonly string[];
	/** Paths absent from the snapshot but present now: deleted by the restore. */
	readonly delete: readonly string[];
}

/**
 * Refs live under a private namespace: `refs/vibe/...` never shows up in `git branch`, is not pushed
 * by default, and cannot collide with anything the user creates.
 */
export function snapshotRefName(id: string): string {
	return `refs/vibe/checkpoints/${id}`;
}

/** Argv (without the leading `git`) for the commands a snapshot needs. */
export const SNAPSHOT_ARGV = {
	repoRoot: ['rev-parse', '--show-toplevel'],
	/** Stage everything — tracked, modified and untracked alike — into the temporary index. */
	stageAll: ['add', '-A'],
	writeTree: ['write-tree'],
	/**
	 * Wrap the tree in a parentless commit. Without this the snapshot is an unreachable object and
	 * `git gc` deletes it — verified: `git gc --prune=now` made a freshly written tree unreadable, so
	 * restoring an older checkpoint would have failed with nothing to point at.
	 */
	commitTree: (tree: string, message: string) => ['commit-tree', tree, '-m', message],
	/** Give the commit a ref so it stays reachable for good, out of the way of user branches. */
	updateRef: (id: string, commit: string) => [`update-ref`, snapshotRefName(id), commit],
	readTree: (tree: string) => ['read-tree', tree],
	/** Write the temporary index out over the working tree. */
	checkoutIndex: ['checkout-index', '-a', '-f'],
	listTree: (tree: string) => ['ls-tree', '-r', '--name-only', tree],
	/** Everything git currently considers part of the working set, ignored files excluded. */
	listWorking: ['ls-files', '--cached', '--others', '--exclude-standard'],
} as const;

/** A tree object id as printed by `git write-tree`. */
const TREE_ID_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function isSnapshotTreeId(value: string | undefined): value is string {
	return typeof value === 'string' && TREE_ID_PATTERN.test(value.trim());
}

/** Split `git` output into non-empty lines. NUL-separated output is handled by the caller. */
export function parsePathList(stdout: string): string[] {
	return stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

/**
 * What restoring `snapshotPaths` over `currentPaths` would touch. Deletions are listed separately
 * because they are the destructive half: a file created after the checkpoint disappears, and no
 * git object holds it afterwards.
 */
export function planSnapshotRestore(
	snapshotPaths: readonly string[],
	currentPaths: readonly string[],
): SnapshotRestorePlan {
	const inSnapshot = new Set(snapshotPaths);
	return {
		restore: [...inSnapshot].sort(),
		delete: currentPaths.filter(p => !inSnapshot.has(p)).sort(),
	};
}
