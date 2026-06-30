/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * In-memory failure counter per (providerName × modelName) tuple. Tracks Empty
 * response / context overflow / invalid-params / etc. events in a rolling time
 * window. When a model exceeds the failure threshold within the window, the
 * tracker recommends user attention.
 *
 * Use case: aggregator-proxied routes (opencode.ai/zen, openrouter, etc.) have
 * transient failure patterns that aren't caught by single-incident detectors.
 * After 3 different failures of `openCodeGo/minimax-m2.7` in 10 minutes, the user
 * should be told "this route is unstable today, try elsewhere" — without nagging
 * them every single failure.
 *
 * Ephemeral by design: state lives in memory, resets on IDE restart. Yesterday's
 * instability doesn't predict today's. No persistence to disk.
 *
 * Categories of failures tracked (extend `FailureKind` if new pathways emerge):
 *   - `empty-response`: provider closed stream without tokens (`reason: unknown` etc.)
 *   - `context-overflow`: overflow regex matched in error body
 *   - `invalid-params`: model emitted tool call that failed schema validation
 *
 * Notification policy:
 *   - First reach of threshold → recommend.
 *   - Within `SUPPRESSION_WINDOW_MS` after last recommendation → silent (don't nag).
 *   - On success (any successful response on the same combo) → reset counter +
 *     reset suppression so next failure cycle re-arms.
 */

export type FailureKind = 'empty-response' | 'context-overflow' | 'invalid-params' | 'provider-error';

/**
 * Classify a provider-side degradation error (gateway 520/529, rate/usage limit, overload, stream
 * stall, retries-exhausted) for health tracking. Returns `'provider-error'` on match, else
 * undefined. Pattern-based and dependency-free — high-confidence phrases only to avoid false
 * positives (the counter resets on the next success, so occasional noise is low-harm anyway).
 */
export function classifyProviderError(message: string | undefined): FailureKind | undefined {
	if (!message) { return undefined; }
	const m = message.toLowerCase();
	const hit =
		/\b(?:52[09]|429)\b/.test(m)                           // gateway 520/529 / rate-limit 429 — word-bounded so "4290" etc. don't match
		|| m.includes('rate limit') || m.includes('rate-limit') || m.includes('too many requests')
		|| m.includes('usage limit') || m.includes('quota')
		|| m.includes('overloaded') || m.includes('capacity')
		|| m.includes('maxretriesexceeded')
		|| (m.includes('stream') && (m.includes('stall') || m.includes('timeout') || m.includes('closed')));
	return hit ? 'provider-error' : undefined;
}

/** Rolling window — only failures within this many ms count toward the threshold. */
export const HEALTH_WINDOW_MS = 10 * 60 * 1000;

/** Minimum failure count within the window to trigger a recommendation. */
export const HEALTH_FAILURE_THRESHOLD = 3;

/** Don't re-recommend the same combo within this window after the last recommendation. */
export const SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;

interface FailureRecord {
	timestamp: number;
	kind: FailureKind;
}

interface CombinedState {
	failures: FailureRecord[];
	lastNotifiedAt: number | undefined;
}

/**
 * Pure helper class — no DI, no service registration. Embed instances in
 * services that surface chat errors (e.g. `chatThreadService`). Tests instantiate
 * with `new ModelHealthTracker()` and call methods directly.
 */
export class ModelHealthTracker {
	private readonly _state = new Map<string, CombinedState>();

	private static key(providerName: string, modelName: string): string {
		return `${providerName}:${modelName}`;
	}

	/** Record a failure. Prunes stale records from the rolling window in-place. */
	recordFailure(providerName: string, modelName: string, kind: FailureKind, now: number = Date.now()): void {
		const key = ModelHealthTracker.key(providerName, modelName);
		const state = this._state.get(key) ?? { failures: [], lastNotifiedAt: undefined };
		const cutoff = now - HEALTH_WINDOW_MS;
		state.failures = state.failures.filter(f => f.timestamp >= cutoff);
		state.failures.push({ timestamp: now, kind });
		this._state.set(key, state);
	}

	/**
	 * Returns true if (1) this combo crossed the failure threshold within the
	 * window AND (2) no notification was shown recently. Caller is expected to
	 * surface a notification when this returns true; the tracker doesn't show
	 * UI itself (separation of concerns).
	 *
	 * After this returns true, the tracker records the notification time —
	 * subsequent calls in the suppression window return false even if the
	 * counter is still over threshold.
	 */
	shouldNotify(providerName: string, modelName: string, now: number = Date.now()): boolean {
		const key = ModelHealthTracker.key(providerName, modelName);
		const state = this._state.get(key);
		if (!state) { return false; }
		// Prune stale on read so a long quiet period after notification doesn't keep
		// the counter alive artificially.
		const cutoff = now - HEALTH_WINDOW_MS;
		state.failures = state.failures.filter(f => f.timestamp >= cutoff);
		if (state.failures.length < HEALTH_FAILURE_THRESHOLD) { return false; }
		if (state.lastNotifiedAt !== undefined && now - state.lastNotifiedAt < SUPPRESSION_WINDOW_MS) { return false; }
		state.lastNotifiedAt = now;
		return true;
	}

	/**
	 * Record a successful response on the same combo — clears the failure
	 * counter AND the notification suppression marker. Next failure cycle
	 * starts fresh.
	 */
	recordSuccess(providerName: string, modelName: string): void {
		const key = ModelHealthTracker.key(providerName, modelName);
		this._state.delete(key);
	}

	/**
	 * Snapshot of failure count for this combo within the current window. Used
	 * by tests and by the notification message ("3 failures in last 10 min").
	 */
	getFailureCount(providerName: string, modelName: string, now: number = Date.now()): number {
		const key = ModelHealthTracker.key(providerName, modelName);
		const state = this._state.get(key);
		if (!state) { return 0; }
		const cutoff = now - HEALTH_WINDOW_MS;
		return state.failures.filter(f => f.timestamp >= cutoff).length;
	}

	/** True if this combo is currently at/over the failure threshold within the rolling window. */
	isDegraded(providerName: string, modelName: string, now: number = Date.now()): boolean {
		return this.getFailureCount(providerName, modelName, now) >= HEALTH_FAILURE_THRESHOLD;
	}

	/** Test-only — wipe all state. */
	clear(): void {
		this._state.clear();
	}
}
