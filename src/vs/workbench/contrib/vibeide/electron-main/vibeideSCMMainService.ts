/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { promisify } from 'util';
import { exec as _exec, execFile as _execFile } from 'child_process';
import { tmpdir } from 'os';
import { join, join as pathJoin } from 'path';
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ChangeRange, IChangedFile, IChangeSet, IVibeideSCMService, IWorkspaceSnapshotRestorePlan } from '../common/vibeideSCMTypes.js';
import { isSnapshotTreeId, parsePathList, parsePinnedSnapshots, planSnapshotRestore, selectStaleSnapshotRefs, shouldReuseSnapshot, snapshotCommitMessage, SnapshotCommitMeta, SNAPSHOT_ARGV } from '../common/workspaceSnapshotPolicy.js';
import { CHANGES_ARGV, chunkChangedFiles, isSafeBranchName, parseNameStatusZ, parsePipelineRunRefs, pathspecOf, pipelineSnapshotMessage, pipelineSnapshotRef, selectStaleRunRefs, splitPatchSections } from '../common/workspaceChangesPolicy.js';

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
 * Спрятать папку рабочего дерева от `git status` — в `.git/info/exclude`, а не в `.gitignore`.
 *
 * `.gitignore` — файл пользователя и он едет в коммит: дописывать туда служебную строку значит
 * менять его репозиторий ради нашей механики. `info/exclude` делает ровно то же самое локально.
 */
const excludeFromGitStatus = async (root: string, relativePath: string): Promise<void> => {
	try {
		const infoDir = pathJoin(root, '.git', 'info');
		const excludeFile = pathJoin(infoDir, 'exclude');
		const line = `/${relativePath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')}/`;
		let current = '';
		try {
			current = await readFile(excludeFile, 'utf8');
		} catch {
			await mkdir(infoDir, { recursive: true });
		}
		if (current.split(/\r?\n/).includes(line)) {
			return;
		}
		await writeFile(excludeFile, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${line}\n`, 'utf8');
	} catch {
		// Не смогли — дерево всё равно создаётся; максимум, что теряется, это чистый `git status`.
	}
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

/**
 * The working tree as a git tree object — tracked, modified and untracked files alike, ignored ones
 * excluded — written through a scratch index. `undefined` when git does not answer with a tree id.
 */
const writeWorkingTree = async (root: string): Promise<string | undefined> => {
	const tree = await withTemporaryIndex(root, async indexFile => {
		await gitArgv(SNAPSHOT_ARGV.stageAll, root, indexFile);
		return gitArgv(SNAPSHOT_ARGV.writeTree, root, indexFile);
	});
	return isSnapshotTreeId(tree) ? tree.trim() : undefined;
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

	/**
	 * История с составом коммитов — сырьё для анализа связанности и починок.
	 *
	 * Идёт через `gitArgv`, а не через оболочку: формат с NUL-разделителем (`%x00`) в кавычках
	 * оболочки не переживает, а именно NUL и делает разбор надёжным — заголовок коммита может
	 * содержать что угодно, кроме него. Слияния исключены: коммит слияния перечисляет чужие
	 * файлы и создал бы связанность там, где её никто не вносил.
	 */
	gitCouplingLog(path: string, days: number, maxCommits: number): Promise<string> {
		return gitArgv([
			'log',
			'--no-merges',
			`--since=${Math.max(1, Math.floor(days))}.days.ago`,
			`-n${Math.max(1, Math.floor(maxCommits))}`,
			'--name-only',
			'--pretty=format:%H%x00%at%x00%s',
		], path);
	}

	async addWorktree(path: string, branch: string, relativePath: string, baseRef?: string): Promise<string> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const worktreePath = pathJoin(root, relativePath);
		await excludeFromGitStatus(root, relativePath);
		await gitArgv(['worktree', 'add', '-b', branch, worktreePath, baseRef ?? 'HEAD'], root);
		return worktreePath;
	}

	async removeWorktree(path: string, worktreePath: string, force?: boolean): Promise<void> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		await gitArgv(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], root);
	}

	async commitWorktree(worktreePath: string, message: string): Promise<boolean> {
		// Индекс тут свой собственный: у каждого рабочего дерева git держит отдельный индекс, и
		// `add -A` в дереве прогона не задевает индекс пользователя в основной папке.
		await gitArgv(['add', '-A'], worktreePath);
		const staged = await gitArgv(['diff', '--cached', '--name-only'], worktreePath);
		if (!staged) {
			return false;
		}
		// `--no-verify` намеренно: хуки пользователя написаны про его собственные коммиты, а этот —
		// служебный снимок работы роли в её ветке. Упавший предкоммитный гейт (типы, линт, тесты) оставил бы
		// работу незафиксированной в дереве — то есть ровно тот исход, ради которого коммит здесь и делается.
		// Проверять работу роли гейтам положено при слиянии в проект, а не при записи в свою ветку.
		await gitArgv(['commit', '--no-verify', '-m', message], worktreePath);
		return true;
	}

	async mergeWorktreeBranch(path: string, branch: string): Promise<void> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		await gitArgv(['merge', '--no-ff', branch], root);
	}

	async deleteBranch(path: string, branch: string, force?: boolean): Promise<void> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		await gitArgv(['branch', force ? '-D' : '-d', branch], root);
	}

	async listConflictedFiles(path: string): Promise<string[]> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const out = await gitArgv(['diff', '--name-only', '--diff-filter=U'], root);
		return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
	}

	async listWorktrees(path: string): Promise<string> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		return await gitArgv(['worktree', 'list', '--porcelain'], root);
	}

	async createWorkspaceSnapshot(path: string, meta?: SnapshotCommitMeta, previousCommit?: string): Promise<string | undefined> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			const tree = await writeWorkingTree(root);
			if (!tree) {
				return undefined;
			}
			// Ход, ничего не изменивший в папке (агент только читал), не порождает второго
			// объекта: одинаковое содержимое даёт одинаковый sha дерева. Экономия здесь
			// второстепенна — важнее, что подряд идущие одинаковые снимки превращают историю
			// ходов в шум, где не видно, какой ход что-то сделал.
			if (previousCommit) {
				try {
					const previousTree = await gitArgv(SNAPSHOT_ARGV.treeOfCommit(previousCommit), root);
					if (shouldReuseSnapshot(tree, previousTree)) {
						return previousCommit;
					}
				} catch {
					// Предыдущего коммита уже нет (сборка мусора, чужая правка ссылок) — пишем новый.
				}
			}
			// A bare tree is unreachable and `git gc` deletes it (verified: `gc --prune=now` made a
			// fresh tree unreadable). Wrap it in a commit and give that commit a ref, so a snapshot
			// survives for as long as the checkpoint that points at it.
			const commit = await gitArgv(SNAPSHOT_ARGV.commitTree(tree, snapshotCommitMessage(tree, meta)), root, undefined, SNAPSHOT_IDENTITY);
			if (!isSnapshotTreeId(commit)) {
				return undefined;
			}
			await gitArgv(SNAPSHOT_ARGV.updateRef(commit.trim(), commit.trim()), root);
			return commit.trim();
		} catch {
			// No repository, no git on PATH, or a repository too broken to stage: checkpoints keep
			// working with their own file snapshots, they just cannot cover terminal-side changes.
			return undefined;
		}
	}

	async pruneWorkspaceSnapshots(path: string, liveSnapshotIds: readonly string[]): Promise<number> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			const pinned = parsePinnedSnapshots(await gitArgv(SNAPSHOT_ARGV.listSnapshotRefs, root));
			const stale = selectStaleSnapshotRefs(pinned, liveSnapshotIds, Date.now());
			for (const id of stale) {
				// Dropping the ref only un-pins the objects; git reclaims them on its own schedule, so
				// nothing the user still points at can disappear as a side effect of this call.
				await gitArgv(SNAPSHOT_ARGV.deleteRef(id), root).catch(() => { /* already gone */ });
			}
			return stale.length;
		} catch {
			return 0;
		}
	}

	async pinPipelineSnapshot(path: string, run: string, label: string): Promise<string | undefined> {
		const ref = pipelineSnapshotRef(run, label);
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			const tree = await writeWorkingTree(root);
			if (!tree) {
				return undefined;
			}
			// A commit with a ref, like a checkpoint: a bare tree is unreachable and `gc` may take it mid-run.
			const commit = await gitArgv(SNAPSHOT_ARGV.commitTree(tree, pipelineSnapshotMessage(run, label, tree)), root, undefined, SNAPSHOT_IDENTITY);
			if (!isSnapshotTreeId(commit)) {
				return undefined;
			}
			await gitArgv(CHANGES_ARGV.pinRef(ref, commit.trim()), root);
			return commit.trim();
		} catch {
			return undefined;
		}
	}

	async releasePipelineSnapshots(path: string, run: string): Promise<void> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			const refs = parsePipelineRunRefs(await gitArgv(CHANGES_ARGV.listRunRefs, root));
			for (const pinned of refs.filter(ref => ref.run === run)) {
				await gitArgv(CHANGES_ARGV.deleteRef(pinned.ref), root).catch(() => { /* already gone */ });
			}
		} catch {
			// Housekeeping: a pin left behind is swept later by `prunePipelineSnapshots`.
		}
	}

	async prunePipelineSnapshots(path: string, minAgeMs: number): Promise<number> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			const stale = selectStaleRunRefs(parsePipelineRunRefs(await gitArgv(CHANGES_ARGV.listRunRefs, root)), Date.now(), minAgeMs);
			for (const ref of stale.refs) {
				await gitArgv(CHANGES_ARGV.deleteRef(ref), root).catch(() => { /* already gone */ });
			}
			return stale.runs;
		} catch {
			return 0;
		}
	}

	async listChanges(path: string, range: ChangeRange): Promise<IChangeSet | undefined> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			// Asked in the folder itself: git knows where it sits in the repository even when the folder
			// was opened through a symlink, which comparing absolute paths would not survive.
			const prefix = await gitArgv(CHANGES_ARGV.showPrefix, path);
			let from: string;
			let to: string | undefined;
			if (range.kind === 'snapshot') {
				if (!isSnapshotTreeId(range.commit)) {
					return undefined;
				}
				from = await gitArgv(CHANGES_ARGV.treeOf(range.commit), root);
				to = await writeWorkingTree(root);
			} else {
				if (!isSafeBranchName(range.branch)) {
					return undefined;
				}
				const base = await gitArgv(CHANGES_ARGV.mergeBase(range.branch), root);
				from = await gitArgv(CHANGES_ARGV.treeOf(base), root);
				to = await gitArgv(CHANGES_ARGV.treeOf(range.branch), root);
			}
			if (!isSnapshotTreeId(from) || !to || !isSnapshotTreeId(to)) {
				return undefined;
			}
			const files = parseNameStatusZ(await gitArgv(CHANGES_ARGV.nameStatus(from, to), root));
			return { prefix, from, to, files };
		} catch {
			return undefined;
		}
	}

	async diffChanges(path: string, from: string, to: string, files: readonly IChangedFile[], maxChars: number): Promise<string[]> {
		if (!isSnapshotTreeId(from) || !isSnapshotTreeId(to)) {
			throw new Error(`Не похоже на деревья git: ${from}, ${to}`);
		}
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const sections: string[] = [];
		let collected = 0;
		for (const chunk of chunkChangedFiles(files)) {
			if (collected > maxChars) {
				break;
			}
			const patch = await gitArgv(CHANGES_ARGV.patch(from, to, chunk.flatMap(pathspecOf)), root);
			for (const section of splitPatchSections(patch)) {
				if (collected > maxChars) {
					break;
				}
				sections.push(section);
				collected += section.length;
			}
		}
		return sections;
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
