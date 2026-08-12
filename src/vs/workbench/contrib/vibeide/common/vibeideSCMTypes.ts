/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { SnapshotCommitMeta } from './workspaceSnapshotPolicy.js';
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
	/**
	 * Снимок рабочей папки. `meta` подписывает коммит (ход, инструмент), `previousCommit` позволяет
	 * не плодить объект, когда папка с прошлого снимка не менялась, — тогда он же и возвращается.
	 */
	createWorkspaceSnapshot(path: string, meta?: SnapshotCommitMeta, previousCommit?: string): Promise<string | undefined>;
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
	/** Снимок папки. `meta` подписывает коммит, `previousCommit` даёт переиспользовать неизменённое. */
	capture(meta?: SnapshotCommitMeta, previousCommit?: string): Promise<string | undefined>;
	/** What restoring the snapshot would touch, without touching anything. */
	plan(tree: string): Promise<IWorkspaceSnapshotRestorePlan | undefined>;
	/** Overwrite the working tree from the snapshot. Destructive — confirm with the user first. */
	restore(tree: string): Promise<IWorkspaceSnapshotRestorePlan>;
	/** Release snapshots no checkpoint points at any more. Never throws. */
	prune(liveSnapshotIds: readonly string[]): Promise<number>;
}

export const IVibeWorkspaceSnapshotService = createDecorator<IVibeWorkspaceSnapshotService>('vibeWorkspaceSnapshotService');

/**
 * Repository state as the agent asks for it: no path to pass, and a folder that is not a git
 * repository answers with a plain sentence instead of throwing.
 *
 * Exists so the agent can learn what changed WITHOUT the terminal. Reading state through
 * `run_command` costs a terminal approval for what is a read, drags shell quoting and locale into
 * the answer, and hands the model a wall of output whose size nobody bounded. The main process
 * already runs these four commands for commit-message generation — this is the same data, offered
 * as a tool rather than re-implemented.
 */
export interface IVibeGitReadService {
	readonly _serviceBrand: undefined;
	/** `git diff --stat` of the open folder, or a sentence explaining why there is nothing. */
	stat(): Promise<string>;
	/** Diffs of the most substantially changed files (sampled, so the output stays bounded). */
	sampledDiffs(): Promise<string>;
	/** Current branch name. */
	branch(): Promise<string>;
	/** Last commits, merges excluded. */
	log(): Promise<string>;
}

export const IVibeGitReadService = createDecorator<IVibeGitReadService>('vibeGitReadService');
