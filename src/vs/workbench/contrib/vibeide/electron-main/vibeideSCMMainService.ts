/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { promisify } from 'util';
import { exec as _exec, execFile as _execFile } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { copyFile, rm } from 'fs/promises';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IVibeideSCMService, IWorkspaceSnapshotRestorePlan } from '../common/vibeideSCMTypes.js';
import { isSnapshotTreeId, parsePathList, planSnapshotRestore, SNAPSHOT_ARGV } from '../common/workspaceSnapshotPolicy.js';

interface NumStat {
	file: string;
	added: number;
	removed: number;
}

const exec = promisify(_exec);

//8000 and 10 were chosen after some experimentation on small-to-moderately sized changes
const MAX_DIFF_LENGTH = 8000;
const MAX_DIFF_FILES = 10;

const git = async (command: string, path: string): Promise<string> => {
	const { stdout, stderr } = await exec(`${command}`, { cwd: path });
	if (stderr) {
		throw new Error(stderr);
	}
	return stdout.trim();
};

const getNumStat = async (path: string, useStagedChanges: boolean): Promise<NumStat[]> => {
	const staged = useStagedChanges ? '--staged' : '';
	const output = await git(`git diff --numstat ${staged}`, path);
	return output
		.split('\n')
		.map((line) => {
			const [added, removed, file] = line.split('\t');
			return {
				file,
				added: parseInt(added, 10) || 0,
				removed: parseInt(removed, 10) || 0,
			};
		});
};

const getSampledDiff = async (file: string, path: string, useStagedChanges: boolean): Promise<string> => {
	const staged = useStagedChanges ? '--staged' : '';
	const diff = await git(`git diff --unified=0 --no-color ${staged} -- "${file}"`, path);
	return diff.slice(0, MAX_DIFF_LENGTH);
};

const hasStagedChanges = async (path: string): Promise<boolean> => {
	const output = await git('git diff --staged --name-only', path);
	return output.length > 0;
};

const execFile = promisify(_execFile);

/**
 * Run git with an argv (never a shell string — repository paths contain spaces) and, for snapshot
 * work, a private index file. Unlike `git()` above, stderr alone is not treated as failure: git
 * writes progress and advice there on perfectly successful commands.
 */
const gitArgv = async (
	args: readonly string[],
	cwd: string,
	indexFile?: string,
	extraEnv?: Readonly<Record<string, string>>,
): Promise<string> => {
	const env = { ...process.env, ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}), ...extraEnv };
	const { stdout } = await execFile('git', [...args], { cwd, env, maxBuffer: 64 * 1024 * 1024 });
	return stdout.trim();
};

/**
 * `commit-tree` refuses to run without an author identity, and a repository may have none configured
 * (or an identity the user would not want on their history). Snapshots are ours, so they are signed
 * as ours and never touch `user.name` / `user.email`.
 */
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: 'VibeIDE',
	GIT_AUTHOR_EMAIL: 'snapshot@vibeide.local',
	GIT_COMMITTER_NAME: 'VibeIDE',
	GIT_COMMITTER_EMAIL: 'snapshot@vibeide.local',
} as const;

const SNAPSHOT_COMMIT_MESSAGE = 'VibeIDE checkpoint snapshot';

/**
 * Run `body` against a scratch index that is deleted afterwards, leaving the real index untouched.
 *
 * The scratch index is seeded from the repository's own index when one exists. This is not an
 * optimisation detail but the difference between usable and not: `git add -A` against an empty
 * index re-hashes every file in the tree, which on a repository this size takes seconds, whereas a
 * seeded index hits git's stat cache and only hashes what actually changed.
 */
const withTemporaryIndex = async <T>(root: string, body: (indexFile: string) => Promise<T>): Promise<T> => {
	const indexFile = join(tmpdir(), `vibe-snapshot-${generateUuid()}.index`);
	try {
		const gitDir = await gitArgv(['rev-parse', '--absolute-git-dir'], root);
		await copyFile(join(gitDir, 'index'), indexFile).catch(() => { /* fresh repo: no index yet */ });
		return await body(indexFile);
	} finally {
		await rm(indexFile, { force: true }).catch(() => { /* scratch file, best effort */ });
	}
};

export class VibeideSCMService extends Disposable implements IVibeideSCMService {
	readonly _serviceBrand: undefined;

	constructor() {
		super();
	}

	async gitStat(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path);
		const staged = useStagedChanges ? '--staged' : '';
		return git(`git diff --stat ${staged}`, path);
	}

	async gitSampledDiffs(path: string): Promise<string> {
		const useStagedChanges = await hasStagedChanges(path);
		const numStatList = await getNumStat(path, useStagedChanges);
		const topFiles = numStatList
			.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
			.slice(0, MAX_DIFF_FILES);
		const diffs = await Promise.all(topFiles.map(async ({ file }) => ({ file, diff: await getSampledDiff(file, path, useStagedChanges) })));
		return diffs.map(({ file, diff }) => `==== ${file} ====\n${diff}`).join('\n\n');
	}

	gitBranch(path: string): Promise<string> {
		return git('git branch --show-current', path);
	}

	gitLog(path: string): Promise<string> {
		return git('git log --pretty=format:"%h|%s|%ad" --date=short --no-merges -n 5', path);
	}

	async createWorkspaceSnapshot(path: string): Promise<string | undefined> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			return await withTemporaryIndex(root, async indexFile => {
				await gitArgv(SNAPSHOT_ARGV.stageAll, root, indexFile);
				const tree = await gitArgv(SNAPSHOT_ARGV.writeTree, root, indexFile);
				if (!isSnapshotTreeId(tree)) {
					return undefined;
				}
				// A bare tree is unreachable and `git gc` deletes it (verified: `gc --prune=now` made a
				// fresh tree unreadable). Wrap it in a commit and give that commit a ref, so a snapshot
				// survives for as long as the checkpoint that points at it.
				const commit = await gitArgv(
					SNAPSHOT_ARGV.commitTree(tree.trim(), SNAPSHOT_COMMIT_MESSAGE),
					root,
					indexFile,
					SNAPSHOT_IDENTITY,
				);
				if (!isSnapshotTreeId(commit)) {
					return undefined;
				}
				await gitArgv(SNAPSHOT_ARGV.updateRef(commit.trim(), commit.trim()), root);
				return commit.trim();
			});
		} catch {
			// No repository, no git on PATH, or a repository too broken to stage: checkpoints keep
			// working with their own file snapshots, they just cannot cover terminal-side changes.
			return undefined;
		}
	}

	async planWorkspaceSnapshotRestore(path: string, tree: string): Promise<IWorkspaceSnapshotRestorePlan> {
		if (!isSnapshotTreeId(tree)) { throw new Error(`Не похоже на снимок рабочего дерева: ${tree}`); }
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const [snapshotPaths, currentPaths] = await Promise.all([
			gitArgv(SNAPSHOT_ARGV.listTree(tree), root).then(parsePathList),
			gitArgv(SNAPSHOT_ARGV.listWorking, root).then(parsePathList),
		]);
		return planSnapshotRestore(snapshotPaths, currentPaths);
	}

	async restoreWorkspaceSnapshot(path: string, tree: string): Promise<IWorkspaceSnapshotRestorePlan> {
		const plan = await this.planWorkspaceSnapshotRestore(path, tree);
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		await withTemporaryIndex(root, async indexFile => {
			await gitArgv(SNAPSHOT_ARGV.readTree(tree), root, indexFile);
			await gitArgv(SNAPSHOT_ARGV.checkoutIndex, root, indexFile);
		});
		// Files created after the snapshot are not in the tree, so checkout-index cannot remove
		// them; without this the restore silently leaves them behind and looks half-applied.
		for (const relative of plan.delete) {
			await rm(join(root, relative), { force: true }).catch(() => { /* already gone */ });
		}
		return plan;
	}
}
