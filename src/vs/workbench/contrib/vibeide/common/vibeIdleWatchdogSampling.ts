/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Idle Watchdog — pure sampling-interval decision (roadmap W.50 adaptive + 1630 burst).
 *
 * Extracted from `electron-main/vibeIdleWatchdogService.ts` so the cadence logic is unit
 * testable without pulling in `electron`. Two orthogonal modifiers over the base interval:
 *
 *   - **adaptive stretch** (W.50): when idle > 1h, multiply the base interval by 6× to
 *     reduce overnight log volume on a quiet machine.
 *   - **burst** (1630): when sustained growth / pre-OOM is detected, temporarily SHRINK
 *     the interval to a few seconds for a handful of ticks so a sub-60s memory spike is
 *     captured instead of slipping between two 5-minute samples (root cause of the OOM
 *     incidents #008 / 2026-05-27 / 2026-05-30 — the renderer died <90s after a healthy
 *     sample). Burst takes precedence over adaptive: a leak in progress overrides idleness.
 */

/** Idle duration (seconds) past which adaptive sampling stretches the interval (W.50). */
export const ADAPTIVE_IDLE_THRESHOLD_SEC = 3600;
/** Multiplier applied to the base interval when adaptive stretch is active (W.50). */
export const ADAPTIVE_RATE_MULTIPLIER = 6;

export interface SamplingIntervalInput {
	/** Remaining ticks of fast (burst) sampling; > 0 means burst is active. */
	readonly burstTicksRemaining: number;
	/** Burst tick interval in seconds (already clamped by the config reader). */
	readonly burstSeconds: number;
	/** Whether adaptive stretch is enabled. */
	readonly adaptive: boolean;
	/** Base interval in minutes. */
	readonly intervalMinutes: number;
	/** Milliseconds since the last observed user activity (for adaptive stretch). */
	readonly idleMs: number;
}

/**
 * Resolve the effective sampling interval in milliseconds.
 *
 * Precedence: burst (fast) → adaptive stretch (slow when idle) → base.
 */
export function computeSamplingIntervalMs(input: SamplingIntervalInput): number {
	if (input.burstTicksRemaining > 0) {
		return input.burstSeconds * 1000;
	}
	const baseMs = input.intervalMinutes * 60 * 1000;
	if (!input.adaptive) {
		return baseMs;
	}
	return input.idleMs > ADAPTIVE_IDLE_THRESHOLD_SEC * 1000 ? baseMs * ADAPTIVE_RATE_MULTIPLIER : baseMs;
}
