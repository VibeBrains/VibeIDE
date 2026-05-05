/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeMultiAgentService } from '../common/vibeMultiAgentService.js';
import { IVibeGitWorktreeService } from '../common/vibeGitWorktreeService.js';
import { IVibeCheckpointCoordinator } from '../common/vibeCheckpointCoordinatorService.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

/**
 * Roadmap § B.4 — compact status: agent worktree rows + checkpoint lock holder.
 */
export class VibeMultiAgentObservationStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeMultiAgentObservationStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private readonly _refresh: RunOnceScheduler;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeMultiAgentService private readonly _multiAgent: IVibeMultiAgentService,
		@IVibeGitWorktreeService private readonly _worktree: IVibeGitWorktreeService,
		@IVibeCheckpointCoordinator private readonly _checkpoint: IVibeCheckpointCoordinator,
	) {
		super();
		this._refresh = this._register(new RunOnceScheduler(() => this._entry?.update(this._props()), 200));
		this._entry = this._statusbarService.addEntry(
			this._props(),
			'vibeide.multiagent.observe',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 169 }, alignment: StatusbarAlignment.RIGHT }
		);
		this._register(this._worktree.onWorktreeCreated(() => this._refresh.schedule()));
		this._register(this._worktree.onWorktreeMerged(() => this._refresh.schedule()));
		this._register(this._refresh); // dispose scheduler
		// Checkpoint holder is not observable; low-rate poll picks up clears after merges.
		const h = window.setInterval(() => this._refresh.schedule(), 4000);
		this._register({ dispose: () => clearInterval(h) });
		this._refresh.schedule();
	}

	private _props(): IStatusbarEntry {
		const agents = this._multiAgent.getAgents().length;
		const wtActive = this._worktree.getWorktrees().filter(w => w.isAgentWorktree).length;
		const lock = this._checkpoint.exclusiveHolderLabel;
		const hasAny = agents > 0 || wtActive > 0 || !!lock;
		if (!hasAny) {
			return {
				name: localize('vibeideMaObsSbName', 'VibeIDE agents / worktrees'),
				text: '',
				ariaLabel: localize('vibeideMaObsSbAriaIdle', 'No isolated agent worktrees'),
				tooltip: localize(
					'vibeideMaObsSbTipIdle',
					'Isolation status: idle. Multi-agent sessions and git worktrees will show counts here; checkpoint mutex holder when active.'
				),
			};
		}
		const lockHint = lock
			? localize('vibeideMaObsLock', 'checkpoint lock: {0}', lock)
			: localize('vibeideMaObsNoLock', 'no checkpoint lock');
		return {
			name: localize('vibeideMaObsSbName', 'VibeIDE agents / worktrees'),
			text: `A:${agents} W:${wtActive}${lock ? ' L' : ''}`,
			ariaLabel: localize('vibeideMaObsAria', 'Agents {0}, agent worktrees {1}. {2}', agents, wtActive, lockHint),
			tooltip: localize('vibeideMaObsTip', '{0}; agents derived from isolated worktrees.', lockHint),
		};
	}
}

registerWorkbenchContribution2(
	VibeMultiAgentObservationStatusBarContribution.ID,
	VibeMultiAgentObservationStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
