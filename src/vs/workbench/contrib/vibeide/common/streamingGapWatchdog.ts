/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Streaming gap watchdog (K.4 / 958, 959, 960) — pure FSM.
 *
 * The agent is "thinking" while bytes flow from the provider. If the gap
 * between chunks exceeds a configured timeout, we want a clear UX:
 *
 *   typing → (gap > gapTimeout) → waiting → (retry or cancel) → ...
 *
 * The runtime stitches this FSM to the chat UI: emit the spinner label
 * change, fire `Repeat request` button, propagate cancellation tokens.
 *
 * Discriminated-union state per "Architectural notes" — every transition
 * is a pure function returning the next state plus a side-effect descriptor
 * the wrapper executes (toast, log, abort).
 *
 * vscode-free: no imports beyond standard lib.
 */

export type WatchdogState =
	| { kind: 'idle' }
	| { kind: 'streaming'; lastChunkAt: number; chunkCount: number }
	| { kind: 'waiting'; lastChunkAt: number; chunkCount: number; waitingSince: number }
	| { kind: 'retrying'; attempt: 1 | 2; nextRetryAt: number }
	| { kind: 'failed'; reason: 'gap-timeout' | 'cancelled' | 'provider-error'; finalAt: number }
	| { kind: 'completed'; finalAt: number };

export type WatchdogEvent =
	| { kind: 'start'; now: number }
	| { kind: 'chunk'; now: number }
	| { kind: 'tick'; now: number }
	| { kind: 'complete'; now: number }
	| { kind: 'cancel'; now: number }
	| { kind: 'provider-error'; now: number }
	| { kind: 'retry-now'; now: number };

export type WatchdogSideEffect =
	| { kind: 'show-typing' }
	| { kind: 'show-waiting' }
	| { kind: 'show-retrying'; attempt: 1 | 2 }
	| { kind: 'auto-retry-scheduled'; afterMs: number; attempt: 1 | 2 }
	| { kind: 'audit'; event: 'stream_gap_recovered' | 'stream_failed' | 'stream_cancelled' | 'stream_completed' }
	| { kind: 'no-op' };

export interface WatchdogConfig {
	/** Default 30 000 ms — gap before "waiting…". */
	gapTimeoutMs: number;
	/** First auto-retry delay (default 5 000). */
	retry1AfterMs: number;
	/** Second auto-retry delay (default 15 000). */
	retry2AfterMs: number;
	/** Auto-retry budget. After this we surface "Connection lost". */
	maxAutoRetries: 0 | 1 | 2;
}

export const WATCHDOG_DEFAULTS: WatchdogConfig = {
	gapTimeoutMs: 30_000,
	retry1AfterMs: 5_000,
	retry2AfterMs: 15_000,
	maxAutoRetries: 2,
};

export interface WatchdogTransition {
	state: WatchdogState;
	effects: WatchdogSideEffect[];
}

/**
 * Single transition function. Pure — no closures, no Date.now(), no side
 * effects on the input. Wrapper consumes `effects` and applies them.
 *
 * Unrecognised event/state pairs return the unchanged state + `no-op` so the
 * runtime can layer this without exhaustiveness anxiety; specific edge cases
 * (cancel from `failed`) are explicit `no-op` rather than throwing.
 */
export function transitionWatchdog(
	state: WatchdogState,
	event: WatchdogEvent,
	config: WatchdogConfig = WATCHDOG_DEFAULTS,
): WatchdogTransition {
	switch (event.kind) {
		case 'start':
			return {
				state: { kind: 'streaming', lastChunkAt: event.now, chunkCount: 0 },
				effects: [{ kind: 'show-typing' }],
			};

		case 'chunk': {
			if (state.kind === 'streaming') {
				return {
					state: { kind: 'streaming', lastChunkAt: event.now, chunkCount: state.chunkCount + 1 },
					effects: [],
				};
			}
			if (state.kind === 'waiting') {
				return {
					state: { kind: 'streaming', lastChunkAt: event.now, chunkCount: state.chunkCount + 1 },
					effects: [{ kind: 'show-typing' }, { kind: 'audit', event: 'stream_gap_recovered' }],
				};
			}
			if (state.kind === 'retrying') {
				return {
					state: { kind: 'streaming', lastChunkAt: event.now, chunkCount: 1 },
					effects: [{ kind: 'show-typing' }, { kind: 'audit', event: 'stream_gap_recovered' }],
				};
			}
			return { state, effects: [{ kind: 'no-op' }] };
		}

		case 'tick': {
			if (state.kind === 'streaming') {
				const gap = event.now - state.lastChunkAt;
				if (gap > config.gapTimeoutMs) {
					return {
						state: { kind: 'waiting', lastChunkAt: state.lastChunkAt, chunkCount: state.chunkCount, waitingSince: event.now },
						effects: [{ kind: 'show-waiting' }],
					};
				}
				return { state, effects: [] };
			}
			if (state.kind === 'waiting' && config.maxAutoRetries >= 1) {
				const sinceWait = event.now - state.waitingSince;
				if (sinceWait >= config.retry1AfterMs) {
					return {
						state: { kind: 'retrying', attempt: 1, nextRetryAt: event.now + config.retry1AfterMs },
						effects: [
							{ kind: 'show-retrying', attempt: 1 },
							{ kind: 'auto-retry-scheduled', afterMs: 0, attempt: 1 },
						],
					};
				}
			}
			if (state.kind === 'retrying' && state.attempt === 1 && config.maxAutoRetries >= 2 && event.now >= state.nextRetryAt) {
				return {
					state: { kind: 'retrying', attempt: 2, nextRetryAt: event.now + config.retry2AfterMs },
					effects: [
						{ kind: 'show-retrying', attempt: 2 },
						{ kind: 'auto-retry-scheduled', afterMs: 0, attempt: 2 },
					],
				};
			}
			if (state.kind === 'retrying' && state.attempt === 2 && event.now >= state.nextRetryAt) {
				return {
					state: { kind: 'failed', reason: 'gap-timeout', finalAt: event.now },
					effects: [{ kind: 'audit', event: 'stream_failed' }],
				};
			}
			return { state, effects: [] };
		}

		case 'complete':
			if (state.kind === 'completed' || state.kind === 'failed') {
				return { state, effects: [{ kind: 'no-op' }] };
			}
			return {
				state: { kind: 'completed', finalAt: event.now },
				effects: [{ kind: 'audit', event: 'stream_completed' }],
			};

		case 'cancel':
			if (state.kind === 'completed' || state.kind === 'failed') {
				return { state, effects: [{ kind: 'no-op' }] };
			}
			return {
				state: { kind: 'failed', reason: 'cancelled', finalAt: event.now },
				effects: [{ kind: 'audit', event: 'stream_cancelled' }],
			};

		case 'provider-error':
			if (state.kind === 'completed' || state.kind === 'failed') {
				return { state, effects: [{ kind: 'no-op' }] };
			}
			return {
				state: { kind: 'failed', reason: 'provider-error', finalAt: event.now },
				effects: [{ kind: 'audit', event: 'stream_failed' }],
			};

		case 'retry-now':
			if (state.kind === 'waiting' || state.kind === 'retrying') {
				const attempt: 1 | 2 = state.kind === 'retrying' && state.attempt === 1 ? 2 : 1;
				return {
					state: { kind: 'retrying', attempt, nextRetryAt: event.now },
					effects: [
						{ kind: 'show-retrying', attempt },
						{ kind: 'auto-retry-scheduled', afterMs: 0, attempt },
					],
				};
			}
			return { state, effects: [{ kind: 'no-op' }] };
	}
}
