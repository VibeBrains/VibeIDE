/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

/**
 * The EH `onDidChangeResponsiveChange(isResponsive:false)` event is TRANSIENT — it
 * fires whenever the extension host misses a few heartbeats (busy with a big op,
 * VS Code auto-profiling it, a slow extension), and the EH recovers on its own
 * moments later. It is NOT a crash. We debounce: only treat it as a real
 * disconnect if the EH stays unresponsive past this window; a recovery
 * (`isResponsive:true`) cancels the pending decision. Without this, a flapping EH
 * spams the recovery prompt on every blip while an agent run is tool-running
 * (observed once native FC let agents stay in tool-running for real, 0.13.20).
 */
const EH_UNRESPONSIVE_DEBOUNCE_MS = 15_000;

export class VibeEHCrashRecoveryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeEHCrashRecovery';

	/** ms when the stream started per threadId — used as checkpoint age approximation. */
	private readonly _runStartMs = new Map<string, number>();

	/** Pending debounce timer for a sustained-unresponsive decision (null = none). */
	private _unresponsiveTimer: ReturnType<typeof setTimeout> | null = null;

	/** Runs already shown a recovery prompt — prevents re-prompting the same run. */
	private readonly _promptedRuns = new Set<string>();

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
				this._promptedRuns.delete(threadId); // run ended — allow a fresh prompt next time
			}
		}));

		// EH responsiveness. `isResponsive:false` is transient (busy/profiling), so
		// debounce: only act if it STAYS down past EH_UNRESPONSIVE_DEBOUNCE_MS. A
		// recovery cancels the pending decision. See the const's doc comment.
		this._register(this._extensionService.onDidChangeResponsiveChange(e => {
			if (e.isResponsive) {
				if (this._unresponsiveTimer) { clearTimeout(this._unresponsiveTimer); this._unresponsiveTimer = null; }
				return;
			}
			if (this._unresponsiveTimer) { return; } // already waiting out the window
			this._unresponsiveTimer = setTimeout(() => {
				this._unresponsiveTimer = null;
				this._handleDisconnect();
			}, EH_UNRESPONSIVE_DEBOUNCE_MS);
		}));
		this._register({ dispose: () => { if (this._unresponsiveTimer) { clearTimeout(this._unresponsiveTimer); this._unresponsiveTimer = null; } } });
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

		// Already surfaced a recovery prompt for this run — don't stack another one
		// if the EH keeps flapping. Cleared when the run ends (onDidChangeStreamState).
		if (this._promptedRuns.has(runningThreadId)) {
			this._log.info('[VibeEHCrashRecovery] recovery already prompted for this run — skipping duplicate.');
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
		const lastCheckpointAgeMs = startMs !== undefined ? now - startMs : null;

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

		// Mark this run so a flapping EH doesn't stack duplicate prompts (see guard
		// above). 'silent' shows nothing, so it stays eligible for a later prompt.
		if (decision.action !== 'silent') {
			this._promptedRuns.add(runningThreadId);
		}

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
