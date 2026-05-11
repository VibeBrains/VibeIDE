/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Extension host crash / disconnect UX (roadmap L.4 L1033).
 *
 * Listens to IExtensionService.onDidChangeResponsiveChange (isResponsive: false).
 * For any in-flight agent run, reads the active thread's phase + estimated
 * checkpoint age + plan state, calls decideEHCrashRecovery, and surfaces the
 * appropriate notification with Resume / Discard / New Thread actions.
 *
 * Pure decision logic lives in common/extensionHostCrashRecovery.ts (17 unit-tests).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IChatThreadService } from './chatThreadService.js';
import { PlanMessage } from '../common/chatThreadServiceTypes.js';
import {
	decideEHCrashRecovery,
	describeEHCrashRecovery,
	SessionPhase,
	PlanContext,
} from '../common/extensionHostCrashRecovery.js';

export class VibeEHCrashRecoveryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeEHCrashRecovery';

	/** ms when the stream started per threadId — used as checkpoint age approximation. */
	private readonly _runStartMs = new Map<string, number>();

	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();

		// Track when each thread starts/stops a run (for checkpoint age approximation).
		this._register(this._chatThreadService.onDidChangeStreamState(({ threadId }) => {
			const s = this._chatThreadService.streamState[threadId];
			const active = s?.isRunning === 'LLM' || s?.isRunning === 'tool' || s?.isRunning === 'preparing';
			if (active) {
				if (!this._runStartMs.has(threadId)) {
					this._runStartMs.set(threadId, Date.now());
				}
			} else {
				this._runStartMs.delete(threadId);
			}
		}));

		// Listen for EH becoming unresponsive (crash / hang / cold disconnect).
		this._register(this._extensionService.onDidChangeResponsiveChange(e => {
			if (!e.isResponsive) {
				this._handleDisconnect();
			}
		}));
	}

	private _handleDisconnect(): void {
		const now = Date.now();
		const { streamState, state } = this._chatThreadService;

		// Find the first thread that is actively running.
		const runningThreadId = Object.keys(streamState).find(id => {
			const s = streamState[id];
			return s?.isRunning === 'LLM' || s?.isRunning === 'tool' || s?.isRunning === 'preparing';
		});

		if (!runningThreadId) {
			this._log.info('[VibeEHCrashRecovery] EH unresponsive — no running thread, silent.');
			return;
		}

		const threadStreamState = streamState[runningThreadId];
		let phase: SessionPhase = 'idle';
		if (threadStreamState?.isRunning === 'LLM' || threadStreamState?.isRunning === 'preparing') {
			phase = 'streaming-llm';
		} else if (threadStreamState?.isRunning === 'tool') {
			phase = 'tool-running';
		}

		// Approximate checkpoint age as time elapsed since the run started.
		const startMs = this._runStartMs.get(runningThreadId);
		const lastCheckpointAgeMs = startMs != null ? now - startMs : null;

		// Check for an executing plan in this thread.
		let planCtx: PlanContext | null = null;
		const thread = state.allThreads[runningThreadId];
		if (thread) {
			let execPlan: PlanMessage | undefined;
			for (let i = thread.messages.length - 1; i >= 0; i--) {
				const m = thread.messages[i];
				if (m.role === 'plan' && (m as PlanMessage).approvalState === 'executing') {
					execPlan = m as PlanMessage;
					break;
				}
			}
			if (execPlan?.persistedPlanId) {
				const completedCount = execPlan.steps.filter(s => s.status === 'succeeded' || s.status === 'skipped').length;
				planCtx = {
					planId: execPlan.persistedPlanId,
					lastCompletedStepIdx: completedCount - 1,
					totalSteps: execPlan.steps.length,
				};
				phase = 'plan-executing';
			}
		}

		const decision = decideEHCrashRecovery({
			phase,
			lastCheckpointAgeMs,
			plan: planCtx,
			crashKind: 'extension-host-disconnect',
		});

		this._log.warn(`[VibeEHCrashRecovery] action=${decision.action} reason=${decision.reason} thread=${runningThreadId} phase=${phase}`);

		const banner = describeEHCrashRecovery(decision);

		switch (decision.action) {
			case 'silent':
				break;

			case 'integrate-plan-resume':
				// VibePersistedPlanResumeContribution re-surfaces the plan on next EH activation.
				if (banner) {
					this._notificationService.info(banner);
				}
				break;

			case 'pause-and-prompt-resume':
				this._notificationService.prompt(
					Severity.Warning,
					banner,
					[
						{
							label: localize('vibeide.ehCrash.retry', 'Повторить запрос'),
							run: () => { void this._chatThreadService.retryStalledStream(runningThreadId); },
						},
						{
							label: localize('vibeide.ehCrash.discard', 'Отменить'),
							run: () => { void this._chatThreadService.abortRunning(runningThreadId); },
						},
					],
					{ sticky: true },
				);
				break;

			case 'force-discard-with-warning':
				this._notificationService.prompt(
					Severity.Error,
					banner,
					[
						{
							label: localize('vibeide.ehCrash.newThread', 'Новый тред'),
							run: () => { this._chatThreadService.openNewThread(); },
						},
					],
					{ sticky: true },
				);
				break;
		}
	}
}

registerWorkbenchContribution2(
	VibeEHCrashRecoveryContribution.ID,
	VibeEHCrashRecoveryContribution,
	WorkbenchPhase.AfterRestored,
);
