/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** What a working-tree restore would touch, shown to the user before anything is overwritten. */
export interface IWorkspaceSnapshotRestorePlan {
	readonly restore: readonly string[];
	readonly delete: readonly string[];
}

export interface IVibeideSCMService {
	readonly _serviceBrand: undefined;
	/**
	 * Capture the whole working tree (including untracked files) as a git tree object, using a
	 * temporary index so the user's staged changes are untouched. Returns `undefined` when the
	 * folder is not a usable git repository — checkpoints then keep their own file snapshots only.
	 *
	 * @param path Any path inside the repository
	 */
	createWorkspaceSnapshot(path: string): Promise<string | undefined>;
	/**
	 * What `restoreWorkspaceSnapshot` would overwrite and delete, without touching anything.
	 *
	 * @param path Any path inside the repository
	 * @param tree Tree id returned by `createWorkspaceSnapshot`
	 */
	planWorkspaceSnapshotRestore(path: string, tree: string): Promise<IWorkspaceSnapshotRestorePlan>;
	/**
	 * Overwrite the working tree from a snapshot and delete files created after it. Destructive by
	 * nature — callers must confirm with the user first, and the returned plan says what was done.
	 *
	 * @param path Any path inside the repository
	 * @param tree Tree id returned by `createWorkspaceSnapshot`
	 */
	restoreWorkspaceSnapshot(path: string, tree: string): Promise<IWorkspaceSnapshotRestorePlan>;
	/**
	 * Drop pinned snapshots no checkpoint refers to any more, returning how many were released.
	 *
	 * Each snapshot keeps a whole worktree of git objects alive, so a deleted thread would otherwise
	 * leave that weight in the user's repository forever.
	 *
	 * @param path Any path inside the repository
	 * @param liveSnapshotIds Ids still referenced by a checkpoint
	 */
	pruneWorkspaceSnapshots(path: string, liveSnapshotIds: readonly string[]): Promise<number>;
	/**
	 * Get git diff --stat
	 *
	 * @param path Path to the git repository
	 */
	gitStat(path: string): Promise<string>;
	/**
	 * Get git diff --stat for the top 10 most significantly changed files according to lines added/removed
	 *
	 * @param path Path to the git repository
	 */
	gitSampledDiffs(path: string): Promise<string>;
	/**
	 * Get the current git branch
	 *
	 * @param path Path to the git repository
	 */
	gitBranch(path: string): Promise<string>;
	/**
	 * Get the last 5 commits excluding merges
	 *
	 * @param path Path to the git repository
	 */
	gitLog(path: string): Promise<string>;
}

export const IVibeideSCMService = createDecorator<IVibeideSCMService>('vibeideSCMService');

/**
 * Working-tree snapshots as the chat uses them: no repository path to pass, and capture never
 * throws — a missing snapshot degrades a checkpoint, it must not break one.
 */
export interface IVibeWorkspaceSnapshotService {
	readonly _serviceBrand: undefined;
	/** Snapshot the open folder, or `undefined` if it is not a usable git repository. */
	capture(): Promise<string | undefined>;
	/** What restoring the snapshot would touch, without touching anything. */
	plan(tree: string): Promise<IWorkspaceSnapshotRestorePlan | undefined>;
	/** Overwrite the working tree from the snapshot. Destructive — confirm with the user first. */
	restore(tree: string): Promise<IWorkspaceSnapshotRestorePlan>;
	/** Release snapshots no checkpoint points at any more. Never throws. */
	prune(liveSnapshotIds: readonly string[]): Promise<number>;
}

export const IVibeWorkspaceSnapshotService = createDecorator<IVibeWorkspaceSnapshotService>('vibeWorkspaceSnapshotService');
