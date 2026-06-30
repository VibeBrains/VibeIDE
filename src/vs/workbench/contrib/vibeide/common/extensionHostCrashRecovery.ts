/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Extension host crash UX — pure decision helper.
 *
 * L.4 line 1035 — when the extension host disconnects during an agent run, the
 * current session state is undefined: tools may have started but not committed,
 * stream chunks may have been lost, and any persisted plan is now mid-step.
 * The runtime needs a single source of truth for "what should we offer the
 * user when the EH comes back?".
 *
 * This module owns the decision logic only — file IO, banner display, and
 * IChatThreadService manipulation live in the contribution that wires it.
 * Adoption order:
 *   1. ExtHost-disconnect listener captures the session phase + checkpoint state.
 *   2. Calls `decideEHCrashRecovery({ phase, lastCheckpointAgeMs, plan, crashKind })`.
 *   3. Branches on the returned `action`:
 *        - 'silent'                  → restore listeners, no UI noise.
 *        - 'pause-and-prompt-resume' → notification with "Resume" / "Discard" actions.
 *        - 'force-discard-with-warning' → no clean state to resume — show warning,
 *                                         clear streaming buffers, offer fresh thread.
 *        - 'integrate-plan-resume'   → defer to VibePersistedPlanResumeContribution.
 */

export type SessionPhase =
	| 'idle'
	| 'streaming-llm'
	| 'tool-running'
	| 'plan-executing';

export type EHCrashKind =
	| 'extension-host-disconnect'
	| 'process-exit'
	| 'window-close-while-running';

export interface PlanContext {
	readonly planId: string;
	readonly lastCompletedStepIdx: number;
	readonly totalSteps: number;
}

export type EHRecoveryAction =
	| { readonly action: 'silent'; readonly reason: 'idle-at-crash' | 'no-state-to-restore' }
	| { readonly action: 'pause-and-prompt-resume'; readonly reason: 'streaming-interrupted' | 'tool-running-with-checkpoint'; readonly checkpointAgeMs: number }
	| { readonly action: 'force-discard-with-warning'; readonly reason: 'tool-running-no-checkpoint' | 'checkpoint-too-old'; readonly checkpointAgeMs: number | null }
	| { readonly action: 'integrate-plan-resume'; readonly reason: 'plan-executing-defer-to-plan-runtime'; readonly planId: string; readonly lastCompletedStepIdx: number };

export interface EHRecoveryInput {
	readonly phase: SessionPhase;
	/** Age of the most recent agent checkpoint at the time of crash, or null if no checkpoint. */
	readonly lastCheckpointAgeMs: number | null;
	readonly plan: PlanContext | null;
	readonly crashKind: EHCrashKind;
	/**
	 * Threshold above which a checkpoint is considered "too old to safely resume".
	 * Default 30 minutes — beyond that the workspace state likely diverged enough that
	 * silent resume could mis-attribute changes.
	 */
	readonly maxCheckpointAgeMs?: number;
}

const DEFAULT_MAX_CHECKPOINT_AGE_MS = 30 * 60 * 1_000;

/**
 * Pure: decides recovery action. Discriminated union — no exceptions, no `any`.
 *
 * Decision tree (top to bottom):
 *   1. plan-executing  → integrate-plan-resume (the plan runtime owns recovery; we
 *                        only pass through the plan handle).
 *   2. idle            → silent (nothing was in flight).
 *   3. tool-running:
 *      a. no checkpoint            → force-discard-with-warning (cannot safely revert).
 *      b. checkpoint too old       → force-discard-with-warning (workspace likely diverged).
 *      c. fresh checkpoint         → pause-and-prompt-resume (user picks Resume/Discard).
 *   4. streaming-llm:
 *      a. fresh or no checkpoint   → pause-and-prompt-resume (lost tokens are recoverable
 *                                    by re-running the prompt; we surface the option).
 *
 * Note: 'window-close-while-running' is treated identically to 'extension-host-disconnect'
 * in this version; differentiation only matters for telemetry and is left to the caller.
 */
export function decideEHCrashRecovery(input: EHRecoveryInput): EHRecoveryAction {
	if (input.phase === 'plan-executing' && input.plan) {
		return {
			action: 'integrate-plan-resume',
			reason: 'plan-executing-defer-to-plan-runtime',
			planId: input.plan.planId,
			lastCompletedStepIdx: input.plan.lastCompletedStepIdx,
		};
	}
	if (input.phase === 'idle') {
		return { action: 'silent', reason: 'idle-at-crash' };
	}
	const maxAge = input.maxCheckpointAgeMs ?? DEFAULT_MAX_CHECKPOINT_AGE_MS;
	const cpAge = input.lastCheckpointAgeMs;
	if (input.phase === 'tool-running') {
		if (cpAge === null) {
			return { action: 'force-discard-with-warning', reason: 'tool-running-no-checkpoint', checkpointAgeMs: null };
		}
		if (cpAge > maxAge) {
			return { action: 'force-discard-with-warning', reason: 'checkpoint-too-old', checkpointAgeMs: cpAge };
		}
		return { action: 'pause-and-prompt-resume', reason: 'tool-running-with-checkpoint', checkpointAgeMs: cpAge };
	}
	// streaming-llm
	return {
		action: 'pause-and-prompt-resume',
		reason: 'streaming-interrupted',
		checkpointAgeMs: cpAge ?? 0,
	};
}

/**
 * Pure: human-readable banner text for the chosen action. Russian (matches existing
 * VibeIDE notification convention). Caller wires the action buttons separately.
 */
export function describeEHCrashRecovery(action: EHRecoveryAction): string {
	switch (action.action) {
		case 'silent':
			return '';
		case 'integrate-plan-resume':
			return `VibeIDE: соединение с расширением прервано во время выполнения плана. Возобновить с шага ${action.lastCompletedStepIdx + 1} плана ${action.planId}?`;
		case 'pause-and-prompt-resume':
			return action.reason === 'tool-running-with-checkpoint'
				? `VibeIDE: соединение прервано во время выполнения инструмента. Доступен чекпойнт (${formatAge(action.checkpointAgeMs)} назад). Восстановить или отменить?`
				: `VibeIDE: поток ответа модели прерван. Повторить запрос?`;
		case 'force-discard-with-warning':
			return action.reason === 'tool-running-no-checkpoint'
				? 'VibeIDE: соединение прервано во время записи. Чекпойнта нет — состояние workspace неопределённо. Откройте git status и решите вручную; новая сессия начнётся с чистого треда.'
				: `VibeIDE: соединение прервано — последний чекпойнт слишком старый (${formatAge(action.checkpointAgeMs!)} назад) для безопасного восстановления. Откройте git status и решите вручную.`;
	}
}

function formatAge(ms: number): string {
	if (ms < 60_000) { return `${Math.round(ms / 1_000)}s`; }
	if (ms < 3_600_000) { return `${Math.round(ms / 60_000)}m`; }
	return `${Math.round(ms / 3_600_000)}h`;
}
