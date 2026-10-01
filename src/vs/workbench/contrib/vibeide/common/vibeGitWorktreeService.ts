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
import { IVibeideSCMService, WorktreeFinishResult } from './vibeideSCMTypes.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { AGENT_BRANCH_PREFIX, parseWorktreeList, worktreeBranchName, worktreeRelativePath } from './worktreeNaming.js';
import { DEFAULT_WORKTREE_INCLUDE_FILES, DEFAULT_WORKTREE_LINK_FOLDERS, IWorktreeIncludeOptions, readPatternList, readWorktreeLinkMode, WORKTREE_INCLUDE_SETTING } from './worktreeIncludePolicy.js';
import { readWorktreeBaseMode, WORKTREE_BASE_SETTING } from './worktreeBasePolicy.js';

/**
 * Чем кончилась фиксация работы роли в её ветке.
 *
 * `nothing` — роль ничего не записала; `failed` — записала, но коммит не состоялся и работа ждёт в дереве.
 */
export type WorktreeCommitOutcome = 'committed' | 'nothing' | 'failed';

export interface WorktreeInfo {
	id: string;
	path: string;
	branch: string;
	isAgentWorktree: boolean;
	sessionId?: string;
	/**
	 * Папки дерева, принесённые ссылкой на папку проекта, — относительно корня дерева
	 * За ними общие файлы пользователя, поэтому прогон в таком дереве не ставит пакеты и не пишет сквозь ссылку
	 * Известны только у дерева, созданного в этом окне: остальным ограничение не нужно — прогона в них нет
	 */
	linked?: readonly string[];
}

export const IVibeGitWorktreeService = createDecorator<IVibeGitWorktreeService>('vibeGitWorktreeService');

export interface IVibeGitWorktreeService {
	readonly _serviceBrand: undefined;

	/** Create a new worktree for agent work */
	createAgentWorktree(sessionId: string): Promise<WorktreeInfo | null>;

	/**
	 * Закоммитить в дереве всё, что прогон наработал.
	 *
	 * Делается ВСЕГДА, независимо от того, сливаем ли дерево: `merge` берёт коммиты ветки, а правки
	 * роли лежат в дереве некоммитнутыми. Без коммита слияние оказалось бы пустым, дерево —
	 * неудаляемым, и работа роли осталась бы в папке, о которой никто не вспомнит.
	 *
	 * Исходов три, а не два, и это важно: «дерево чистое» и «коммит не состоялся» выглядят одинаково только
	 * изнутри кода. Для пользователя это противоположности: в первом случае терять нечего, во втором его работа
	 * лежит в дереве незафиксированной и ждёт рук. Сказать второе первым словами — значит соврать о потере.
	 */
	commitAgentWorktree(worktreeId: string, message: string): Promise<WorktreeCommitOutcome>;

	/**
	 * Вернуть работу роли в проект и убрать дерево с веткой
	 *
	 * Ветка от `HEAD` вливается коммитом слияния; ветка от снимка папки переносится в папку незакоммиченными
	 * правками. Конфликт с правками папки ничего не трогает: дерево и ветка остаются, а ответ называет файлы
	 * Конфликт обычного слияния, как и прежде, — исключение
	 */
	mergeWorktree(worktreeId: string): Promise<WorktreeFinishResult>;

	/**
	 * Отказаться от работы роли: снести дерево и его ветку вместе с невлитыми коммитами.
	 *
	 * Необратимо и потому вызывается только за подтверждением человека: всё, что роль наработала, исчезает.
	 */
	discardWorktree(worktreeId: string): Promise<void>;

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
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
	}

	/** Папка репозитория, внутри которой живут деревья; без открытой папки изоляция невозможна. */
	private _repoPath(): string | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	/** Что приносить в дерево из игнорируемого — из настроек, с умолчаниями политики. */
	private _includeOptions(): IWorktreeIncludeOptions {
		return {
			files: readPatternList(this._configuration.getValue<unknown>(WORKTREE_INCLUDE_SETTING.files), DEFAULT_WORKTREE_INCLUDE_FILES),
			folders: readPatternList(this._configuration.getValue<unknown>(WORKTREE_INCLUDE_SETTING.folders), DEFAULT_WORKTREE_LINK_FOLDERS),
			mode: readWorktreeLinkMode(this._configuration.getValue<unknown>(WORKTREE_INCLUDE_SETTING.mode), isMacintosh),
		};
	}

	async createAgentWorktree(sessionId: string): Promise<WorktreeInfo | null> {
		const repoPath = this._repoPath();
		if (!repoPath) {
			vibeLog.warn('Worktree', 'Нет открытой папки — рабочее дерево создавать негде');
			return null;
		}
		const branch = worktreeBranchName(sessionId);
		const relativePath = worktreeRelativePath(branch);
		const fromWorkingTree = readWorktreeBaseMode(this._configuration.getValue<unknown>(WORKTREE_BASE_SETTING)) === 'workingTree';
		const include = this._includeOptions();
		try {
			// Создание и слияние идут через тот же мьютекс, что и чекпоинты: две операции с индексом
			// одного репозитория одновременно — это гонка за `.git/index`, а не параллелизм.
			// Снимок-база берётся внутри той же секции: между снимком и созданием дерева папка не должна меняться
			// нашими же руками
			const created = await this._checkpointCoordinator.runExclusive({ op: 'worktree:create', holderLabel: branch }, async () => {
				const pruned = await this._scm.pruneWorktreeBases(repoPath);
				if (pruned > 0) {
					vibeLog.info('Worktree', `Сняты базы исчезнувших веток: ${pruned}`);
				}
				const baseRef = fromWorkingTree ? await this._scm.pinWorktreeBase(repoPath, branch) : undefined;
				try {
					return await this._scm.addWorktree(repoPath, branch, relativePath, { ...(baseRef ? { baseRef } : {}), include });
				} catch (e) {
					// Дерева нет — его база держала бы снимок зря
					await this._scm.releaseWorktreeBase(repoPath, branch).catch(() => { /* swept by the next prune */ });
					throw e;
				}
			});
			const worktree: WorktreeInfo = {
				id: `wt-${sessionId}`,
				path: created.path,
				branch,
				isAgentWorktree: true,
				sessionId,
				...(created.linked.length > 0 ? { linked: created.linked } : {}),
			};
			this._worktrees.set(worktree.id, worktree);
			this._onWorktreeCreated.fire(worktree);
			vibeLog.info('Worktree', `Создано дерево ${branch} → ${created.path}${broughtNote(created)}`);
			if (created.failed.length > 0) {
				// Не принесённое — не повод отказываться от изоляции: проверка в дереве скажет сама, чего ей не хватило
				vibeLog.warn('Worktree', `В дерево ${branch} не принесено: ${created.failed.join(', ')}`);
			}
			return worktree;
		} catch (e) {
			// Занятое имя ветки, грязный индекс, не-репозиторий — всё это причины, по которым
			// изоляции не будет. Молча вернуть «дерево есть» нельзя: вызывающий станет писать в
			// общую папку, думая, что пишет в свою.
			vibeLog.error('Worktree', `Не удалось создать дерево ${branch}:`, e);
			return null;
		}
	}

	async commitAgentWorktree(worktreeId: string, message: string): Promise<WorktreeCommitOutcome> {
		const wt = this._worktrees.get(worktreeId);
		if (!wt) {
			return 'failed';
		}
		// Тот же мьютекс, что у создания и слияния: индекс у дерева свой, но `git` в одном
		// репозитории всё равно ходит через общие ссылки.
		return await this._checkpointCoordinator.runExclusive({ op: 'worktree:commit', holderLabel: wt.branch }, async () => {
			try {
				const committed = await this._scm.commitWorktree(wt.path, message);
				vibeLog.info('Worktree', committed ? `Зафиксировано в ${wt.branch}` : `Дерево ${wt.branch} чистое — коммитить нечего`);
				return committed ? 'committed' : 'nothing';
			} catch (e) {
				// Несостоявшийся коммит — это работа, оставшаяся в дереве незафиксированной: отдать
				// её за «ничего не записала» значило бы соврать о потере работы.
				vibeLog.error('Worktree', `Не удалось зафиксировать дерево ${wt.branch}:`, e);
				return 'failed';
			}
		});
	}

	/**
	 * Дерево по идентификатору — сначала из памяти окна, потом у git.
	 *
	 * Без второго шага дерево, оставшееся от прошлого окна, перечисляется, но не сливается и не убирается:
	 * показывать человеку то, что нельзя тронуть, хуже, чем не показывать вовсе.
	 */
	private async _resolveWorktree(worktreeId: string): Promise<WorktreeInfo | undefined> {
		return this._worktrees.get(worktreeId) ?? (await this.listAgentWorktrees()).find(wt => wt.id === worktreeId);
	}

	async discardWorktree(worktreeId: string): Promise<void> {
		await this._checkpointCoordinator.runExclusive({ op: 'worktree:discard', holderLabel: worktreeId }, async () => {
			const wt = await this._resolveWorktree(worktreeId);
			const repoPath = this._repoPath();
			if (!wt || !repoPath) {
				return;
			}
			// `force` в обоих вызовах осознанно: суть команды — выбросить невлитую работу, и осторожный
			// git отказал бы именно в том, зачем пришли. Подтверждение человека берётся выше, в команде.
			await this._scm.removeWorktree(repoPath, wt.path, true);
			await this._scm.deleteBranch(repoPath, wt.branch, true);
			await this._releaseBase(repoPath, wt.branch);
			this._worktrees.delete(worktreeId);
			vibeLog.info('Worktree', `Выброшено дерево ${wt.branch}`);
		});
	}

	/** Снять базу ветки; не вышло — её снимет уборка при следующем создании дерева. */
	private async _releaseBase(repoPath: string, branch: string): Promise<void> {
		try {
			await this._scm.releaseWorktreeBase(repoPath, branch);
		} catch (e) {
			vibeLog.warn('Worktree', `База ветки ${branch} не снята:`, e);
		}
	}

	async mergeWorktree(worktreeId: string): Promise<WorktreeFinishResult> {
		return await this._checkpointCoordinator.runExclusive({ op: 'worktree:merge', holderLabel: worktreeId }, async (): Promise<WorktreeFinishResult> => {
			const wt = await this._resolveWorktree(worktreeId);
			const repoPath = this._repoPath();
			if (!wt || !repoPath) {
				throw new Error(`Дерево ${worktreeId} не найдено — вливать нечего`);
			}
			// Порядок важен: сначала перенос работы. Конфликт — это остановка с сохранённым деревом, а не
			// потеря работы: удали мы дерево первым, чинить конфликт было бы уже нечем.
			const outcome = await this._scm.finishWorktreeBranch(repoPath, wt.branch);
			if (outcome.kind === 'conflict') {
				vibeLog.warn('Worktree', `Работа ${wt.branch} расходится с правками папки в ${outcome.files.join(', ')} — дерево и ветка оставлены`);
				return outcome;
			}
			try {
				await this._scm.removeWorktree(repoPath, wt.path);
				// Перенесённая в папку работа в истории HEAD не значится, и осторожное `-d` отказало бы в удалении
				await this._scm.deleteBranch(repoPath, wt.branch, outcome.kind !== 'merged');
				await this._releaseBase(repoPath, wt.branch);
			} catch (e) {
				// Работа уже в проекте — несостоявшаяся уборка не повод называть перенос несостоявшимся
				// Оставшиеся дерево и ветка видны в «Деревьях агентов»; повторный перенос ничего не задвоит
				vibeLog.warn('Worktree', `Дерево или ветка ${wt.branch} не убраны после переноса:`, e);
			}
			this._worktrees.delete(worktreeId);
			this._onWorktreeMerged.fire(wt);
			vibeLog.info('Worktree', `Работа ${wt.branch} в проекте (${outcome.kind}), дерево убрано`);
			return outcome;
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
				.filter(entry => entry.branch?.startsWith(AGENT_BRANCH_PREFIX))
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

/** Строка журнала о принесённом в дерево. */
function broughtNote(created: { readonly linked: readonly string[]; readonly cloned: readonly string[]; readonly copied: readonly string[] }): string {
	const parts = [
		created.linked.length > 0 ? `ссылки: ${created.linked.join(', ')}` : '',
		created.cloned.length > 0 ? `копии: ${created.cloned.join(', ')}` : '',
		created.copied.length > 0 ? `файлы: ${created.copied.join(', ')}` : '',
	].filter(Boolean);
	return parts.length > 0 ? ` (${parts.join('; ')})` : '';
}

registerSingleton(IVibeGitWorktreeService, VibeGitWorktreeService, InstantiationType.Delayed);
