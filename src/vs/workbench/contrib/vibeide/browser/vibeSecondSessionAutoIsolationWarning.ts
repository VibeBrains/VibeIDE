/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IChatThreadService } from './chatThreadService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { IVibeGitWorktreeService } from '../common/vibeGitWorktreeService.js';

/**
 * Roadmap § B.4 — warn when several chat threads exist with auto edits / autopilot but no isolated worktree.
 */
export class VibeSecondSessionAutoIsolationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeSecondSessionAutoIsolationWarn';

	private _warnedOnce = false;

	constructor(
		@IChatThreadService private readonly _threads: IChatThreadService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
		@IVibeGitWorktreeService private readonly _worktrees: IVibeGitWorktreeService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._register(this._threads.onDidChangeCurrentThread(() => this._check()));
		this._check();
	}

	private _check(): void {
		if (this._warnedOnce) {
			return;
		}
		// Match UI thread lists: empty placeholder threads (e.g. after openNewThread on startup) must not trigger this.
		const threadCount = Object.values(this._threads.state.allThreads).filter(
			t => (t?.messages?.length ?? 0) > 0,
		).length;
		if (threadCount < 2) {
			return;
		}
		const g = this._settings.state.globalSettings;
		const autoDanger = g.chatAgentAutopilot === true || g.autoApprove?.edits === true;
		if (!autoDanger) {
			return;
		}
		const wt = this._worktrees.getWorktrees().filter(w => w.isAgentWorktree).length;
		if (wt > 0) {
			return;
		}
		this._warnedOnce = true;
		this._notifications.notify({
			severity: Severity.Warning,
			message: localize(
				'vibeideSecondAutoNoWt',
				'Multiple chat sessions use auto-approved edits without an isolated git worktree. Writes can conflict on shared branches; use multi-agent / worktree isolation when running agents in parallel.',
			),
		});
	}
}

registerWorkbenchContribution2(
	VibeSecondSessionAutoIsolationContribution.ID,
	VibeSecondSessionAutoIsolationContribution,
	WorkbenchPhase.AfterRestored
);
