/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Context filter mode `auto` — visible-toast emit policy (pure helper).
 *
 * K.1 line 901 — `vibeide.context.filterMode = auto` quietly turns on aggregation
 * once context fills above 70%. Without a UI signal this violates the "Ты видишь
 * всё" narrative: the agent silently swaps a raw log for a compressed one without
 * the user realising. Two cures:
 *   (a) change default to 'raw'              — too aggressive (breaks long sessions)
 *   (b) emit a visible toast at first trigger
 * This module implements (b) with an emit-once-per-session policy.
 *
 * Adoption order:
 *   1. The contribution that owns `IVibeContextFilterService` keeps a per-session
 *      flag `_hasShownAutoAggregationToast: boolean` (false at session start).
 *   2. Every time `getLastFilterStats()` reports compression in 'auto' mode, the
 *      contribution calls `decideContextFilterToast({ mode, ctxPct, hasShownToastThisSession, threshold? })`.
 *   3. If `emit` is true, INotificationService.notify(`describeContextFilterToast(...)`),
 *      then set `_hasShownAutoAggregationToast = true`.
 *   4. The session flag resets when a new chat thread is opened.
 */

export type ContextFilterMode = 'auto' | 'raw' | 'aggregate' | 'off';

export type ToastEmitReason =
	| 'first-auto-trigger'
	| 'mode-not-auto'
	| 'below-threshold'
	| 'already-shown';

export interface ToastDecision {
	readonly emit: boolean;
	readonly reason: ToastEmitReason;
	readonly thresholdPct: number;
}

export interface ToastDecisionInput {
	readonly mode: ContextFilterMode;
	/** Current context fill, 0..1. Values outside the range are clamped before comparison. */
	readonly ctxPct: number;
	readonly hasShownToastThisSession: boolean;
	/** Trigger threshold for 'auto' aggregation, 0..1. Default 0.70 (matches service default). */
	readonly threshold?: number;
}

const DEFAULT_THRESHOLD = 0.70;

/**
 * Pure: decides whether to emit the visible toast on the current call.
 *
 * Rules (top-down):
 *   1. mode !== 'auto'              → no emit ('mode-not-auto'); user picked the mode.
 *   2. hasShownToastThisSession     → no emit ('already-shown'); we surfaced it once.
 *   3. clamp(ctxPct) < threshold    → no emit ('below-threshold'); aggregation hasn't kicked in.
 *   4. otherwise                    → emit ('first-auto-trigger').
 *
 * The threshold is returned in the decision so the toast text can quote the boundary.
 */
export function decideContextFilterToast(input: ToastDecisionInput): ToastDecision {
	const thresholdPct = clampPct(input.threshold ?? DEFAULT_THRESHOLD);
	if (input.mode !== 'auto') {
		return { emit: false, reason: 'mode-not-auto', thresholdPct };
	}
	if (input.hasShownToastThisSession) {
		return { emit: false, reason: 'already-shown', thresholdPct };
	}
	const fill = clampPct(input.ctxPct);
	if (fill < thresholdPct) {
		return { emit: false, reason: 'below-threshold', thresholdPct };
	}
	return { emit: true, reason: 'first-auto-trigger', thresholdPct };
}

/**
 * Pure: renders the Russian toast body. Includes the threshold so the user knows
 * what tripped the policy. Intended for INotificationService with a primary action
 * "Открыть полный лог" (wires to the existing `vibeide.contextFilter.openFullLog`
 * command).
 */
export function describeContextFilterToast(thresholdPct: number): string {
	const pct = Math.round(thresholdPct * 100);
	return `VibeIDE: контекст ≥ ${pct}% — включена авто-агрегация инструментов. Можно открыть полный сырой лог или сменить режим в настройках.`;
}

function clampPct(v: number): number {
	if (!Number.isFinite(v)) { return 0; }
	if (v < 0) { return 0; }
	if (v > 1) { return 1; }
	return v;
}
