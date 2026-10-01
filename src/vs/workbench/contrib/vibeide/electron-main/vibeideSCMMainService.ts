/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { promisify } from 'util';
import { exec as _exec, execFile as _execFile } from 'child_process';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, join as pathJoin } from 'path';
import { copyFile, lstat, mkdir, readFile, rm, rmdir, symlink, unlink, writeFile } from 'fs/promises';
import { cp } from '@vscode/fs-copyfile';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ChangeRange, IAddedWorktree, IAddWorktreeOptions, IChangedFile, IChangeSet, IVibeideSCMService, IWorkspaceSnapshotRestorePlan, WorktreeFinishResult } from '../common/vibeideSCMTypes.js';
import { isSnapshotTreeId, parsePathList, parsePinnedSnapshots, planSnapshotRestore, selectStaleSnapshotRefs, shouldReuseSnapshot, snapshotCommitMessage, SnapshotCommitMeta, SNAPSHOT_ARGV } from '../common/workspaceSnapshotPolicy.js';
import { CHANGES_ARGV, chunkChangedFiles, isSafeBranchName, parseNameStatusZ, parsePipelineRunRefs, pathspecOf, pipelineSnapshotMessage, pipelineSnapshotRef, selectStaleRunRefs, splitPatchSections } from '../common/workspaceChangesPolicy.js';
import { folderExcludeLine, IWorktreeIncludeOptions, linkExcludeLine, LINKED_PATHS_FILE, parseNulList, selectIncludeFiles, selectLinkFolders, WORKTREE_INCLUDE_ARGV } from '../common/worktreeIncludePolicy.js';
import { decideWorktreeBase, decideWorktreeFinish, parseMergeTreeZ, selectOrphanBasePins, WORKTREE_BASE_ARGV } from '../common/worktreeBasePolicy.js';

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
 * Спрятать пути от `git status` — в `info/exclude`, а не в `.gitignore`.
 *
 * `.gitignore` — файл пользователя и он едет в коммит: дописывать туда служебную строку значит
 * менять его репозиторий ради нашей механики. `info/exclude` делает ровно то же самое локально.
 *
 * Путь к файлу спрашивается у git: в репозитории, где `.git` — файл (подмодуль, дерево), `<корень>/.git/info`
 * указывал бы в никуда
 */
const excludeFromGitStatus = async (root: string, lines: readonly string[]): Promise<void> => {
	try {
		const reported = await gitArgv(WORKTREE_INCLUDE_ARGV.excludeFile, root);
		const excludeFile = isAbsolute(reported) ? reported : pathJoin(root, reported);
		let current = '';
		try {
			current = await readFile(excludeFile, 'utf8');
		} catch {
			await mkdir(dirname(excludeFile), { recursive: true });
		}
		const present = new Set(current.split(/\r?\n/));
		const missing = [...new Set(lines)].filter(line => !present.has(line));
		if (missing.length === 0) {
			return;
		}
		await writeFile(excludeFile, `${current}${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`, 'utf8');
	} catch {
		// Не смогли — дерево всё равно создаётся; максимум, что теряется, это чистый `git status`.
		// Ссылки при этом в коммит не уйдут: `commitWorktree` снимает их с индекса сам
	}
};

/**
 * Git с кодом выхода вместо исключения на ненулевом коде
 * Нужен там, где код выхода — часть ответа: у `merge-tree` код 1 значит «конфликт», а не «сломалось»
 */
const gitArgvWithStatus = async (args: readonly string[], cwd: string): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
	try {
		return { stdout: await gitArgv(args, cwd), exitCode: 0 };
	} catch (error) {
		const failure = error as { code?: unknown; stdout?: unknown };
		if (typeof failure.code === 'number' && typeof failure.stdout === 'string') {
			return { stdout: failure.stdout.trim(), exitCode: failure.code };
		}
		throw error;
	}
};

/** Служебный каталог дерева в `.git/worktrees/<имя>`, или `undefined`, если дерева уже нет. */
const worktreeGitDir = async (worktreePath: string): Promise<string | undefined> => {
	try {
		return await gitArgv(WORKTREE_INCLUDE_ARGV.worktreeGitDir, worktreePath);
	} catch {
		return undefined;
	}
};

/**
 * Ссылки на общие папки, принесённые в дерево
 *
 * Список лежит в служебном каталоге дерева, а не в памяти окна: снимать ссылки перед удалением нужно и
 * для дерева, оставшегося от прошлого запуска IDE
 */
const readLinkedPaths = async (worktreePath: string): Promise<string[]> => {
	const gitDir = await worktreeGitDir(worktreePath);
	if (!gitDir) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(await readFile(join(gitDir, LINKED_PATHS_FILE), 'utf8'));
		// Файл могли править руками: путь, уводящий из дерева, не трогается ни на диске, ни в индексе
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0 && !isAbsolute(item) && !item.split(/[\\/]/).includes('..'))
			: [];
	} catch {
		return [];
	}
};

/**
 * Снять ссылки дерева на общие папки — как ссылки, никогда не сквозь них
 *
 * `lstat` подтверждает, что на месте всё ещё ссылка: настоящую папку (копию, или ту, что роль положила
 * вместо ссылки) уберёт вместе с деревом сам git
 * Ссылку, которую снять не удалось, нельзя отдавать на удаление дерева: чужой обход каталогов мог бы пройти
 * сквозь неё в папку пользователя
 */
const unlinkSharedFolders = async (worktreePath: string): Promise<void> => {
	const stuck: string[] = [];
	for (const relative of await readLinkedPaths(worktreePath)) {
		const link = join(worktreePath, relative);
		let isLink = false;
		try {
			isLink = (await lstat(link)).isSymbolicLink();
		} catch {
			continue;
		}
		if (!isLink) {
			continue;
		}
		try {
			await unlink(link);
		} catch {
			// Точка соединения Windows для части API — каталог: снимается `rmdir`, тоже без обхода содержимого
			await rmdir(link).catch(() => stuck.push(relative));
		}
	}
	if (stuck.length > 0) {
		throw new Error(`Не удалось снять ссылки ${stuck.join(', ')} в дереве ${worktreePath} — дерево не удаляется, чтобы не задеть общие папки проекта`);
	}
};

const EMPTY_INCLUDE = { linked: [], cloned: [], copied: [], failed: [] } as const;

/**
 * Принести в новое дерево игнорируемое git: файлы копируются, папки — копией при записи или ссылкой
 *
 * Ошибка по одному пути не роняет остальные: дерево без `.env` хуже, чем с ним, но лучше, чем никакого
 */
const bringIgnoredInto = async (root: string, worktreePath: string, options: IWorktreeIncludeOptions): Promise<Omit<IAddedWorktree, 'path'>> => {
	const tracked = parseNulList(await gitArgv(WORKTREE_INCLUDE_ARGV.trackedFiles, worktreePath));
	const folders = options.mode === 'none' || options.folders.length === 0
		? []
		: selectLinkFolders(parseNulList(await gitArgv(WORKTREE_INCLUDE_ARGV.ignoredEntries, root)), options.folders, tracked);
	const files = options.files.length === 0
		? []
		: selectIncludeFiles(parseNulList(await gitArgv(WORKTREE_INCLUDE_ARGV.ignoredFiles(options.files, folders), root)), options.files, tracked, folders);

	const linked: string[] = [];
	const cloned: string[] = [];
	const copied: string[] = [];
	const failed: string[] = [];
	if (options.mode === 'link' && folders.length > 0) {
		// Исключение и список ссылок — до самих ссылок: прерванное на середине создание не должно оставить
		// ссылку, которую `add -A` закоммитит, а удаление дерева не узнает
		await excludeFromGitStatus(root, folders.map(linkExcludeLine));
		const gitDir = await worktreeGitDir(worktreePath);
		if (!gitDir) {
			return { ...EMPTY_INCLUDE, failed: [...folders, ...files] };
		}
		await writeFile(join(gitDir, LINKED_PATHS_FILE), JSON.stringify(folders), 'utf8');
	}
	for (const folder of folders) {
		const source = join(root, folder);
		const target = join(worktreePath, folder);
		try {
			await mkdir(dirname(target), { recursive: true });
			if (options.mode === 'link') {
				// На Windows — точка соединения: обычная ссылка там требует прав администратора или режима разработчика
				await symlink(source, target, isWindows ? 'junction' : 'dir');
				linked.push(folder);
			} else {
				// `verbatimSymlinks` без фильтров даёт на APFS клонирование всей папки одним вызовом
				await cp(source, target, { recursive: true, force: true, verbatimSymlinks: true });
				cloned.push(folder);
			}
		} catch {
			failed.push(folder);
			if (options.mode !== 'link') {
				// Недокопированная папка хуже отсутствующей: сборка в дереве упала бы на половине пакетов
				await rm(target, { recursive: true, force: true }).catch(() => { /* best effort */ });
			}
		}
	}
	for (const file of files) {
		try {
			const target = join(worktreePath, file);
			await mkdir(dirname(target), { recursive: true });
			await cp(join(root, file), target, { force: true, verbatimSymlinks: true });
			copied.push(file);
		} catch {
			failed.push(file);
		}
	}
	return { linked, cloned, copied, failed };
};

/** Сколько раз пересчитывать перенос, если папка менялась, пока он считался. */
const FINISH_ATTEMPTS = 3;

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

	async addWorktree(path: string, branch: string, relativePath: string, options: IAddWorktreeOptions = {}): Promise<IAddedWorktree> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const worktreePath = pathJoin(root, relativePath);
		await excludeFromGitStatus(root, [folderExcludeLine(relativePath)]);
		await gitArgv(['worktree', 'add', '-b', branch, worktreePath, options.baseRef ?? 'HEAD'], root);
		// Ветка уже создана, поэтому сбой здесь — не сбой создания: брошенное исключение оставило бы дерево и ветку
		// без хозяина, а снятая вызывающим база превратила бы её снимок в коммит для обычного слияния
		const brought = options.include
			? await bringIgnoredInto(root, worktreePath, options.include).catch((error: unknown) => ({ ...EMPTY_INCLUDE, failed: [`(${error instanceof Error ? error.message : String(error)})`] }))
			: EMPTY_INCLUDE;
		return { path: worktreePath, ...brought };
	}

	async pinWorktreeBase(path: string, branch: string): Promise<string | undefined> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const existing = await gitArgv(WORKTREE_BASE_ARGV.branchExists(branch), root).catch(() => '');
		if (existing) {
			throw new Error(`Ветка ${branch} уже существует — её база не перезаписывается`);
		}
		const tree = await writeWorkingTree(root);
		if (!tree) {
			throw new Error('git не записал дерево рабочей папки — базу дерева роли снять не из чего');
		}
		const headTree = await gitArgv(WORKTREE_BASE_ARGV.headTree, root).catch(() => '');
		if (decideWorktreeBase(tree, isSnapshotTreeId(headTree) ? headTree : undefined) === 'head') {
			return undefined;
		}
		const commit = (await gitArgv(WORKTREE_BASE_ARGV.commitOnHead(tree), root, undefined, SNAPSHOT_IDENTITY)).trim();
		if (!isSnapshotTreeId(commit)) {
			throw new Error('git не записал коммит снимка рабочей папки');
		}
		// Ссылка держит снимок живым до конца работы роли: на нём считаются и перенос, и дифф для судящих
		await gitArgv(WORKTREE_BASE_ARGV.pin(branch, commit), root);
		return commit;
	}

	async releaseWorktreeBase(path: string, branch: string): Promise<void> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const pinned = await gitArgv(WORKTREE_BASE_ARGV.resolve(branch), root).catch(() => '');
		if (pinned) {
			await gitArgv(WORKTREE_BASE_ARGV.release(branch), root);
		}
	}

	async pruneWorktreeBases(path: string): Promise<number> {
		try {
			const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
			const pins = parsePathList(await gitArgv(WORKTREE_BASE_ARGV.listPins, root));
			if (pins.length === 0) {
				return 0;
			}
			const orphans = selectOrphanBasePins(pins, parsePathList(await gitArgv(WORKTREE_BASE_ARGV.listBranches, root)));
			for (const ref of orphans) {
				await gitArgv(['update-ref', '-d', ref], root).catch(() => { /* already gone */ });
			}
			return orphans.length;
		} catch {
			return 0;
		}
	}

	async removeWorktree(path: string, worktreePath: string, force?: boolean): Promise<void> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		await unlinkSharedFolders(worktreePath);
		await gitArgv(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], root);
	}

	async commitWorktree(worktreePath: string, message: string): Promise<boolean> {
		// Индекс тут свой собственный: у каждого рабочего дерева git держит отдельный индекс, и
		// `add -A` в дереве прогона не задевает индекс пользователя в основной папке.
		await gitArgv(['add', '-A'], worktreePath);
		// Строка `info/exclude` прячет ссылки от `add -A`, но её запись могла не состояться — снимаем их и здесь
		const linked = await readLinkedPaths(worktreePath);
		if (linked.length > 0) {
			await gitArgv(WORKTREE_INCLUDE_ARGV.unstage(linked), worktreePath);
		}
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

	async finishWorktreeBranch(path: string, branch: string): Promise<WorktreeFinishResult> {
		const root = await gitArgv(SNAPSHOT_ARGV.repoRoot, path);
		const base = (await gitArgv(WORKTREE_BASE_ARGV.resolve(branch), root).catch(() => '')).trim();
		if (!isSnapshotTreeId(base)) {
			// Ветка от `HEAD`: обычное слияние, как было всегда
			await gitArgv(['merge', '--no-ff', branch], root);
			return { kind: 'merged' };
		}
		const baseTree = await gitArgv(CHANGES_ARGV.treeOf(base), root);
		const resultTree = await gitArgv(CHANGES_ARGV.treeOf(branch), root);
		for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt++) {
			const folderTree = await writeWorkingTree(root);
			if (!folderTree) {
				throw new Error('git не записал дерево рабочей папки — переносить работу роли вслепую нельзя');
			}
			const decision = decideWorktreeFinish({ baseTree, resultTree, folderTree });
			let target: string;
			if (decision.kind === 'unchanged') {
				return { kind: 'unchanged' };
			} else if (decision.kind === 'apply') {
				target = decision.target;
			} else {
				const { stdout, exitCode } = await gitArgvWithStatus(WORKTREE_BASE_ARGV.mergeTrees(baseTree, folderTree, resultTree), root);
				if (exitCode !== 0 && exitCode !== 1) {
					throw new Error(`git merge-tree завершился с кодом ${exitCode}`);
				}
				const merged = parseMergeTreeZ(stdout, exitCode);
				if (merged.conflicts.length > 0 || !merged.tree) {
					return { kind: 'conflict', files: merged.conflicts };
				}
				if (merged.tree === folderTree) {
					return { kind: 'unchanged' };
				}
				target = merged.tree;
			}
			// Пока считалось слияние, пользователь мог сохранить файл — запись поверх стёрла бы его правку
			if (await writeWorkingTree(root) !== folderTree) {
				continue;
			}
			return { kind: 'applied', files: await this._writeTreeIntoFolder(root, folderTree, target) };
		}
		throw new Error('Папка проекта менялась всё время, пока переносилась работа роли — перенос не сделан, ветка и дерево на месте');
	}

	/**
	 * Привести папку от дерева `from` к дереву `target`, трогая только различающиеся файлы
	 *
	 * Не `restoreWorkspaceSnapshot`: тот переписывает каждый файл проекта, а здесь папка живая — переписанный
	 * без нужды файл будит наблюдателей и сборку и может накрыть правку, сделанную в эту секунду
	 * Индекс пользователя не трогается: работа роли ложится незакоммиченной, как его собственные правки
	 */
	private async _writeTreeIntoFolder(root: string, from: string, target: string): Promise<number> {
		const changes = parseNameStatusZ(await gitArgv(WORKTREE_BASE_ARGV.changedPaths(from, target), root));
		const written = changes.filter(change => change.status !== 'deleted');
		// Сначала удаления: файл, ставший папкой, должен освободить место до записи её содержимого
		for (const change of changes.filter(change => change.status === 'deleted')) {
			await rm(join(root, change.path), { force: true }).catch(() => { /* already gone */ });
		}
		if (written.length > 0) {
			await withTemporaryIndex(root, async indexFile => {
				await gitArgv(SNAPSHOT_ARGV.readTree(target), root, indexFile);
				for (const chunk of chunkChangedFiles(written)) {
					await gitArgv(WORKTREE_BASE_ARGV.checkoutPaths(chunk.map(change => change.path)), root, indexFile);
				}
			});
		}
		return changes.length;
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
				// Ветка от снимка папки меряется от снимка: от `HEAD` в её дифф попали бы правки пользователя,
				// сделанные до старта роли, и судящий шаг приписал бы их ей
				const pinned = (await gitArgv(WORKTREE_BASE_ARGV.resolve(range.branch), root).catch(() => '')).trim();
				const base = isSnapshotTreeId(pinned) ? pinned : await gitArgv(CHANGES_ARGV.mergeBase(range.branch), root);
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
