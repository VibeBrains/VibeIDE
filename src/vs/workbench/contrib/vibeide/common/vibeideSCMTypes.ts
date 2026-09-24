/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { SnapshotCommitMeta } from './workspaceSnapshotPolicy.js';
import type { WriteScope } from './pipeline/vibePipelineFile.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/** What a working-tree restore would touch, shown to the user before anything is overwritten. */
export interface IWorkspaceSnapshotRestorePlan {
	readonly restore: readonly string[];
	readonly delete: readonly string[];
}

/** One changed file between two points of a repository; paths are relative to the repository root. */
export interface IChangedFile {
	readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
	readonly path: string;
	/** Where a renamed or copied file came from. */
	readonly oldPath?: string;
}

/** What changed between two trees of a repository. */
export interface IChangeSet {
	/**
	 * Where the folder asked about sits inside the repository — `packages/app/`, empty at the root.
	 * Paths are relative to the repository root, and this is how they are placed in the folder: by
	 * git's own answer, not by comparing absolute paths, which a symlinked folder would defeat.
	 */
	readonly prefix: string;
	/** Tree ids, as `diffChanges` takes them. */
	readonly from: string;
	readonly to: string;
	readonly files: readonly IChangedFile[];
}

/** Two points to compare: a pinned snapshot and the working tree now, or an agent branch and the commit it forked from. */
export type ChangeRange =
	| { readonly kind: 'snapshot'; readonly commit: string }
	| { readonly kind: 'branch'; readonly branch: string };

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
	 * Pin the working tree, untracked files included, as a commit under
	 * `refs/vibe/pipelines/<run>/<label>` — the point a pipeline measures its changes from.
	 *
	 * A namespace of its own, not the checkpoints': their sweep releases every snapshot no checkpoint
	 * names once it is an hour old, and a pipeline run can last longer. Returns `undefined` when the
	 * folder is not a usable git repository.
	 *
	 * @param path Any path inside the repository
	 */
	pinPipelineSnapshot(path: string, run: string, label: string): Promise<string | undefined>;
	/** Unpin every snapshot of `run`. Never throws. */
	releasePipelineSnapshots(path: string, run: string): Promise<void>;
	/** Unpin runs older than `minAgeMs` — pins a window closed mid-run left behind. Returns how many runs. Never throws. */
	prunePipelineSnapshots(path: string, minAgeMs: number): Promise<number>;
	/**
	 * What changed over `range`, file by file. `undefined` when git cannot say: no repository, a snapshot
	 * or branch that is gone.
	 *
	 * @param path The folder the caller works in — `prefix` of the answer places it in the repository
	 */
	listChanges(path: string, range: ChangeRange): Promise<IChangeSet | undefined>;
	/**
	 * The patch of `files` between the trees of a `listChanges` answer, one section per file in git's
	 * order: new files whole, deleted ones by their header only.
	 *
	 * Collection stops once the sections pass `maxChars`: the caller cuts to its own budget, and
	 * megabytes of patch are not worth moving between processes to be thrown away.
	 */
	diffChanges(path: string, from: string, to: string, files: readonly IChangedFile[], maxChars: number): Promise<string[]>;
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
	/**
	 * History with the files each commit touched: `%H\0%at\0%subject` then one path per line.
	 *
	 * @param path Path to the git repository
	 * @param days How far back to look
	 * @param maxCommits Hard ceiling, so a long-lived repository cannot stall the read
	 */
	gitCouplingLog(path: string, days: number, maxCommits: number): Promise<string>;
	/**
	 * Создать рабочее дерево агента: своя папка, своя ветка от `baseRef`.
	 *
	 * Возвращает абсолютный путь дерева. Папка дерева заодно попадает в `.git/info/exclude` — это
	 * локальный список исключений, поэтому `.gitignore` пользователя мы не трогаем, а дерево не
	 * висит в его `git status` как гора неотслеженных файлов.
	 *
	 * @param path Любой путь внутри репозитория
	 * @param branch Имя ветки дерева; занятое имя — ошибка, а не молчаливое переиспользование
	 * @param relativePath Путь дерева относительно корня репозитория
	 * @param baseRef От чего ответвляться; по умолчанию `HEAD`
	 */
	addWorktree(path: string, branch: string, relativePath: string, baseRef?: string): Promise<string>;
	/**
	 * Убрать рабочее дерево. Без `force` git откажется удалять дерево с несохранёнными правками —
	 * и это верно: молча стереть чужую работу хуже, чем оставить папку.
	 *
	 * @param path Любой путь внутри репозитория
	 * @param worktreePath Путь дерева (абсолютный или относительно корня)
	 */
	removeWorktree(path: string, worktreePath: string, force?: boolean): Promise<void>;
	/**
	 * Закоммитить всё, что прогон наработал в своём дереве, — и сказать, было ли что коммитить.
	 *
	 * Без этого шага изоляция теряет работу: правки агента лежат в дереве НЕкоммитнутыми, а
	 * `merge` берёт коммиты ветки, поэтому слияние оказалось бы пустым, а `worktree remove` упал
	 * бы на грязном дереве. Личность коммита — репозитория: этот коммит остаётся в истории
	 * пользователя, и подписывать его служебным именем незачем.
	 *
	 * @param worktreePath Путь дерева прогона, а не корня репозитория
	 * @returns `false`, если дерево чистое — роль ничего не записала
	 */
	commitWorktree(worktreePath: string, message: string): Promise<boolean>;
	/**
	 * Влить ветку дерева в текущую ветку репозитория отдельным коммитом слияния.
	 *
	 * `--no-ff` намеренно: работа агента должна остаться видимой в истории одним узлом, иначе
	 * «что он сделал» приходится собирать по отдельным коммитам.
	 *
	 * @param path Любой путь внутри репозитория
	 */
	mergeWorktreeBranch(path: string, branch: string): Promise<void>;
	/**
	 * Удалить ветку дерева после слияния.
	 *
	 * Без `force` git отказывается удалять ветку с невлитыми коммитами — это верное умолчание. `force`
	 * нужен ровно там, где невлитую работу выбрасывают намеренно и за подтверждением человека.
	 */
	deleteBranch(path: string, branch: string, force?: boolean): Promise<void>;
	/**
	 * Файлы с неразрешённым конфликтом слияния — путями относительно корня репозитория.
	 *
	 * Спрашивается у git, а не поиском маркеров по проекту: `<<<<<<<` в чужом коде, в тесте или в
	 * документации — не конфликт слияния, и вести из-за него агента в правку незачем.
	 */
	listConflictedFiles(path: string): Promise<string[]>;
	/** `git worktree list --porcelain` как есть — разбирает вызывающая сторона. */
	listWorktrees(path: string): Promise<string>;
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

/** What a judging step is shown of the changes: the patch file by file, and what was held back. */
export interface CollectedDiff {
	/** One section per file in git's order, secrets masked — fewer than `files` when the budget ran out. */
	readonly sections: readonly string[];
	/** Changed files the agent may read — what `sections` is a part of. */
	readonly files: number;
	/** Changed files the agent's read rules close: left out, only counted. */
	readonly hidden: number;
	/** Set when no diff could be taken — why. */
	readonly unavailable?: string;
}

export interface RunDiffRequest {
	/** The pinned snapshot to compare the open folder with; absent — branches only. */
	readonly since?: string;
	/** Agent branches whose work is not merged into the folder, each compared with where it forked. */
	readonly branches: readonly string[];
	/** How much patch to collect, in characters. */
	readonly maxChars: number;
	/** Only files this scope may write: a step's own changes, without its wave neighbours'. */
	readonly within?: WriteScope;
}

/**
 * The changes of a pipeline run as an agent may see them: the files its read rules close are left out,
 * secrets are masked, and the size is bounded.
 *
 * Lives behind a `common` decorator with the git work in the main process, like the snapshot service:
 * the pipeline depends on the decorator and stays free of the transport.
 */
export interface IVibeRunDiffService {
	readonly _serviceBrand: undefined;
	/** Pin the open folder for a pipeline run; `undefined` when it is not a git repository. Never throws. */
	pin(run: string, label: string): Promise<string | undefined>;
	/** What changed, read rules applied and secrets masked, within `maxChars`. Never throws. */
	collect(request: RunDiffRequest): Promise<CollectedDiff>;
	/** Unpin the run's snapshots, and the runs a closed window left behind. Never throws. */
	release(run: string): Promise<void>;
}

export const IVibeRunDiffService = createDecorator<IVibeRunDiffService>('vibeRunDiffService');

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
	/** History with per-commit file lists, for change-coupling and bug-history analysis. */
	couplingLog(days: number, maxCommits: number): Promise<string>;
}

export const IVibeGitReadService = createDecorator<IVibeGitReadService>('vibeGitReadService');
