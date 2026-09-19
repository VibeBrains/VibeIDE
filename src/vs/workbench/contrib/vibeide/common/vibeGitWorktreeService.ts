/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeCheckpointCoordinator } from './vibeCheckpointCoordinatorService.js';
import { IVibeideSCMService } from './vibeideSCMTypes.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { parseWorktreeList, worktreeBranchName, worktreeRelativePath } from './worktreeNaming.js';

export interface WorktreeInfo {
	id: string;
	path: string;
	branch: string;
	isAgentWorktree: boolean;
	sessionId?: string;
}

export const IVibeGitWorktreeService = createDecorator<IVibeGitWorktreeService>('vibeGitWorktreeService');

export interface IVibeGitWorktreeService {
	readonly _serviceBrand: undefined;

	/** Create a new worktree for agent work */
	createAgentWorktree(sessionId: string): Promise<WorktreeInfo | null>;

	/**
	 * Закоммитить в дереве всё, что прогон наработал, — и сказать, было ли что коммитить.
	 *
	 * Делается ВСЕГДА, независимо от того, сливаем ли дерево: `merge` берёт коммиты ветки, а правки
	 * роли лежат в дереве некоммитнутыми. Без коммита слияние оказалось бы пустым, дерево —
	 * неудаляемым, и работа роли осталась бы в папке, о которой никто не вспомнит.
	 */
	commitAgentWorktree(worktreeId: string, message: string): Promise<boolean>;

	/** Merge agent worktree to main after Approve */
	mergeWorktree(worktreeId: string): Promise<void>;

	/**
	 * Create several agent worktrees in one batch (same mutex / logging path as singles).
	 * Used by speculative exploration and any multi-slot flows to avoid duplicated loops.
	 */
	createMultipleAgentWorktrees(sessionPrefix: string, suffixKeys: string[]): Promise<Array<WorktreeInfo | null>>;

	/** Get all active worktrees */
	getWorktrees(): WorktreeInfo[];

	/** Деревья агентов по данным git, а не по памяти окна: переживают перезапуск IDE. */
	listAgentWorktrees(): Promise<WorktreeInfo[]>;

	readonly onWorktreeCreated: Event<WorktreeInfo>;
	readonly onWorktreeMerged: Event<WorktreeInfo>;
}

/**
 * VibeIDE Git Worktree Isolation.
 * Agent works in isolated git worktree.
 * Merge to main only after explicit Approve.
 * Branching conversations: each fork creates new worktree.
 *
 * Rollback in sidebar: always targets active worktree (never main branch).
 */
class VibeGitWorktreeService extends Disposable implements IVibeGitWorktreeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWorktreeCreated = this._register(new Emitter<WorktreeInfo>());
	readonly onWorktreeCreated = this._onWorktreeCreated.event;

	private readonly _onWorktreeMerged = this._register(new Emitter<WorktreeInfo>());
	readonly onWorktreeMerged = this._onWorktreeMerged.event;

	private readonly _worktrees = new Map<string, WorktreeInfo>();

	constructor(
		@IVibeCheckpointCoordinator private readonly _checkpointCoordinator: IVibeCheckpointCoordinator,
		@IVibeideSCMService private readonly _scm: IVibeideSCMService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
	}

	/** Папка репозитория, внутри которой живут деревья; без открытой папки изоляция невозможна. */
	private _repoPath(): string | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	async createAgentWorktree(sessionId: string): Promise<WorktreeInfo | null> {
		const repoPath = this._repoPath();
		if (!repoPath) {
			vibeLog.warn('Worktree', 'Нет открытой папки — рабочее дерево создавать негде');
			return null;
		}
		const branch = worktreeBranchName(sessionId);
		const relativePath = worktreeRelativePath(branch);
		try {
			// Создание и слияние идут через тот же мьютекс, что и чекпоинты: две операции с индексом
			// одного репозитория одновременно — это гонка за `.git/index`, а не параллелизм.
			const path = await this._checkpointCoordinator.runExclusive({ op: 'worktree:create', holderLabel: branch }, async () =>
				await this._scm.addWorktree(repoPath, branch, relativePath));
			const worktree: WorktreeInfo = {
				id: `wt-${sessionId}`,
				path,
				branch,
				isAgentWorktree: true,
				sessionId,
			};
			this._worktrees.set(worktree.id, worktree);
			this._onWorktreeCreated.fire(worktree);
			vibeLog.info('Worktree', `Создано дерево ${branch} → ${path}`);
			return worktree;
		} catch (e) {
			// Занятое имя ветки, грязный индекс, не-репозиторий — всё это причины, по которым
			// изоляции не будет. Молча вернуть «дерево есть» нельзя: вызывающий станет писать в
			// общую папку, думая, что пишет в свою.
			vibeLog.error('Worktree', `Не удалось создать дерево ${branch}:`, e);
			return null;
		}
	}

	async commitAgentWorktree(worktreeId: string, message: string): Promise<boolean> {
		const wt = this._worktrees.get(worktreeId);
		if (!wt) {
			return false;
		}
		// Тот же мьютекс, что у создания и слияния: индекс у дерева свой, но `git` в одном
		// репозитории всё равно ходит через общие ссылки.
		return await this._checkpointCoordinator.runExclusive({ op: 'worktree:commit', holderLabel: wt.branch }, async () => {
			try {
				const committed = await this._scm.commitWorktree(wt.path, message);
				vibeLog.info('Worktree', committed ? `Зафиксировано в ${wt.branch}` : `Дерево ${wt.branch} чистое — коммитить нечего`);
				return committed;
			} catch (e) {
				// Несостоявшийся коммит — это работа, оставшаяся в дереве. Сказать об этом важнее,
				// чем продолжить: слияние дальше по потоку молча не принесёт ничего.
				vibeLog.error('Worktree', `Не удалось зафиксировать дерево ${wt.branch}:`, e);
				return false;
			}
		});
	}

	async mergeWorktree(worktreeId: string): Promise<void> {
		await this._checkpointCoordinator.runExclusive({ op: 'worktree:merge', holderLabel: worktreeId }, async () => {
			const wt = this._worktrees.get(worktreeId);
			if (!wt) {
				return;
			}
			const repoPath = this._repoPath();
			if (!repoPath) {
				return;
			}
			// Порядок важен: сначала слияние. Конфликт — это остановка с сохранённым деревом, а не
			// потеря работы: удали мы дерево первым, чинить конфликт было бы уже нечем.
			await this._scm.mergeWorktreeBranch(repoPath, wt.branch);
			await this._scm.removeWorktree(repoPath, wt.path);
			try {
				await this._scm.deleteBranch(repoPath, wt.branch);
			} catch (e) {
				// Ветка после слияния может остаться (например, на неё уже кто-то сослался) — это не
				// повод считать слияние несостоявшимся.
				vibeLog.warn('Worktree', `Ветка ${wt.branch} не удалена после слияния:`, e);
			}
			this._worktrees.delete(worktreeId);
			this._onWorktreeMerged.fire(wt);
			vibeLog.info('Worktree', `Влито и убрано: ${wt.branch}`);
		});
	}

	/** Деревья агентов, которые git знает прямо сейчас, — включая оставшиеся от прошлых окон. */
	async listAgentWorktrees(): Promise<WorktreeInfo[]> {
		const repoPath = this._repoPath();
		if (!repoPath) {
			return [];
		}
		try {
			const entries = parseWorktreeList(await this._scm.listWorktrees(repoPath));
			return entries
				.filter(entry => entry.branch?.startsWith('vibe-agent-'))
				.map(entry => ({ id: `wt-${entry.branch}`, path: entry.path, branch: entry.branch!, isAgentWorktree: true }));
		} catch (e) {
			vibeLog.warn('Worktree', 'Не удалось перечислить деревья:', e);
			return [];
		}
	}

	async createMultipleAgentWorktrees(sessionPrefix: string, suffixKeys: string[]): Promise<Array<WorktreeInfo | null>> {
		const out: Array<WorktreeInfo | null> = [];
		for (const k of suffixKeys) {
			out.push(await this.createAgentWorktree(`${sessionPrefix}-${k}`));
		}
		return out;
	}

	getWorktrees(): WorktreeInfo[] {
		return Array.from(this._worktrees.values());
	}
}

registerSingleton(IVibeGitWorktreeService, VibeGitWorktreeService, InstantiationType.Delayed);
