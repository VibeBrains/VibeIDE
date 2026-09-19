/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { disposableWindowInterval } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeMultiAgentService } from '../common/vibeMultiAgentService.js';
import { IVibeGitWorktreeService } from '../common/vibeGitWorktreeService.js';
import { IVibeCheckpointCoordinator } from '../common/vibeCheckpointCoordinatorService.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * Roadmap § B.4 — compact status: agent worktree rows + checkpoint lock holder.
 */
export class VibeMultiAgentObservationStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeMultiAgentObservationStatusBar';

	/**
	 * Как часто переспрашивать git про деревья.
	 *
	 * Реже, чем обновление строки: счётчики из памяти бесплатны, а каждый опрос git — это запуск
	 * процесса, а деревья сами по себе не появляются — только по событиям, на которые мы и так подписаны.
	 */
	private static readonly GIT_REFRESH_MS = 30_000;

	private _entry: IStatusbarEntryAccessor | undefined;
	/**
	 * Деревья по данным git, а не по памяти окна.
	 *
	 * Работа роли, оставшаяся в ветке от прошлого запуска IDE, в памяти не числится — и раньше строка
	 * сообщала о нуле деревьев ровно тогда, когда человеку важнее всего узнать, что работа ждёт.
	 */
	private _treesInGit = 0;
	private _unifiedRow: IDisposable | undefined;
	private readonly _refresh: RunOnceScheduler;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeMultiAgentService private readonly _multiAgent: IVibeMultiAgentService,
		@IVibeGitWorktreeService private readonly _worktree: IVibeGitWorktreeService,
		@IVibeCheckpointCoordinator private readonly _checkpoint: IVibeCheckpointCoordinator,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._refresh = this._register(new RunOnceScheduler(() => this._sync(), 200));
		this._wire();
		this._register(this._worktree.onWorktreeCreated(() => this._refresh.schedule()));
		this._register(this._worktree.onWorktreeMerged(() => this._refresh.schedule()));
		this._register(this._refresh);
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
		this._register(disposableWindowInterval(mainWindow, () => this._refresh.schedule(), 4000));
		this._register(disposableWindowInterval(mainWindow, () => void this._refreshFromGit(), VibeMultiAgentObservationStatusBarContribution.GIT_REFRESH_MS));
		this._register(this._worktree.onWorktreeCreated(() => void this._refreshFromGit()));
		this._register(this._worktree.onWorktreeMerged(() => void this._refreshFromGit()));
		this._refresh.schedule();
		void this._refreshFromGit();
	}

	private _wire(): void {
		this._entry?.dispose(); this._entry = undefined;
		this._unifiedRow?.dispose(); this._unifiedRow = undefined;
		const p = this._props();
		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			if (!p.text) { return; }
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.multiagent.observe',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				priority: 169,
			});
		} else {
			this._entry = this._statusbarService.addEntry(p, 'vibeide.multiagent.observe', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 169 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _sync(): void {
		const p = this._props();
		this._entry?.update(p);
		if (this._unifiedRow) {
			if (!p.text) {
				this._unifiedRow.dispose();
				this._unifiedRow = undefined;
			} else {
				this._unified.updateRow('vibeide.multiagent.observe', { label: p.text, tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined });
			}
		} else if (this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true && p.text) {
			this._wire();
		}
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}

	/** Спросить git про деревья и обновить строку, если число изменилось. */
	private async _refreshFromGit(): Promise<void> {
		let count = 0;
		try {
			count = (await this._worktree.listAgentWorktrees()).length;
		} catch {
			// Нет репозитория или git недоступен — строка состояния не то место, где об этом сообщают.
			count = 0;
		}
		if (count === this._treesInGit) { return; }
		this._treesInGit = count;
		this._refresh.schedule();
	}

	private _props(): IStatusbarEntry {
		const agents = this._multiAgent.getAgents().length;
		// git знает и про свои деревья, и про чужие; память окна отвечает быстрее, поэтому берём большее
		// из двух: только что созданное дерево не должно ждать опроса git, а оставшееся от прошлого окна — видно только ему.
		const wtActive = Math.max(this._worktree.getWorktrees().filter(w => w.isAgentWorktree).length, this._treesInGit);
		const lock = this._checkpoint.exclusiveHolderLabel;
		const hasAny = agents > 0 || wtActive > 0 || !!lock;
		if (!hasAny) {
			return {
				name: localize('vibeideMaObsSbName', 'VibeIDE агенты / воркдеревья'),
				text: '',
				ariaLabel: localize('vibeideMaObsSbAriaIdle', 'Изолированных агентских воркдеревьев нет'),
				tooltip: localize(
					'vibeideMaObsSbTipIdle',
					'Статус изоляции: простой. Здесь будут отображаться счётчики мультиагентных сессий и git-воркдеревьев, а при активности — держатель мьютекса чекпоинта.'
				),
			};
		}
		const lockHint = lock
			? localize('vibeideMaObsLock', 'блокировка чекпоинта: {0}', lock)
			: localize('vibeideMaObsNoLock', 'блокировки чекпоинта нет');
		return {
			name: localize('vibeideMaObsSbName', 'VibeIDE агенты / воркдеревья'),
			text: `A:${agents} W:${wtActive}${lock ? ' L' : ''}`,
			ariaLabel: localize('vibeideMaObsAria', 'Агентов: {0}, агентских воркдеревьев: {1}. {2}', agents, wtActive, lockHint),
			tooltip: localize('vibeideMaObsTip', '{0}; агенты привязаны к изолированным воркдеревьям. Щёлкните, чтобы влить или убрать дерево.', lockHint),
			// Счётчик без действия сообщает о ждущей работе и не даёт её забрать — отсюда команда деревьев.
			command: 'vibeide.agent.worktrees',
		};
	}
}

registerWorkbenchContribution2(
	VibeMultiAgentObservationStatusBarContribution.ID,
	VibeMultiAgentObservationStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
