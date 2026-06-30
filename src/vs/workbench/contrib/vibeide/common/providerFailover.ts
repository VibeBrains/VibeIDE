/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Provider auto-failover decision logic (1187).
 *
 * `VibeProviderStatusService` records request outcomes; this module encodes
 * the policy "3 consecutive 5xx / timeouts → switch to next provider in
 * `vibeide.providers.failoverChain`". Pure — no clock, no fetch, no audit
 * sink; the wrapper applies the resulting effects.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ProviderRequestOutcome =
	| 'success'
	| 'timeout'
	| 'server-5xx'
	| 'client-4xx'
	| 'cancelled';

export interface ProviderHealthState {
	currentProviderId: string;
	consecutiveFailures: number;
	lastSwitchAt: number | null;
}

export interface FailoverConfig {
	chain: ReadonlyArray<string>;
	consecutiveFailureThreshold: number;
	/** Min ms between switches — protects against ping-pong when every provider is down. */
	switchCooldownMs: number;
}

export const FAILOVER_DEFAULTS: FailoverConfig = {
	chain: [],
	consecutiveFailureThreshold: 3,
	switchCooldownMs: 30_000,
};

export type FailoverDecision =
	| { kind: 'no-op' }
	| { kind: 'reset-failure-count' }
	| { kind: 'increment-failure-count'; newCount: number }
	| { kind: 'switch'; from: string; to: string; reason: 'consecutive-failures' }
	| { kind: 'chain-exhausted'; lastTriedProviderId: string };

/**
 * Initial state. The wrapper calls this when the user (re-)configures the
 * provider chain, or when failover state is loaded from storage.
 */
export function initFailoverState(initialProviderId: string): ProviderHealthState {
	return {
		currentProviderId: initialProviderId,
		consecutiveFailures: 0,
		lastSwitchAt: null,
	};
}

/**
 * Process one request outcome and return the next state plus a single
 * decision the wrapper applies. Pure — no side effects.
 *
 * Rules:
 *   - success / 4xx → reset failure count (4xx is a request issue, not a
 *     provider outage; resetting prevents false positives from one bad call).
 *   - cancelled → no-op (user-initiated, doesn't reflect provider health).
 *   - timeout / 5xx → increment; if threshold reached and cooldown elapsed,
 *     advance to next provider in chain.
 *   - At end of chain → emit chain-exhausted; the wrapper surfaces a
 *     "all providers down" toast and stops auto-switching.
 */
export function processOutcome(
	state: ProviderHealthState,
	outcome: ProviderRequestOutcome,
	now: number,
	config: FailoverConfig = FAILOVER_DEFAULTS,
): { state: ProviderHealthState; decision: FailoverDecision } {
	if (outcome === 'cancelled') {
		return { state, decision: { kind: 'no-op' } };
	}

	if (outcome === 'success' || outcome === 'client-4xx') {
		if (state.consecutiveFailures === 0) {
			return { state, decision: { kind: 'no-op' } };
		}
		return {
			state: { ...state, consecutiveFailures: 0 },
			decision: { kind: 'reset-failure-count' },
		};
	}

	const nextCount = state.consecutiveFailures + 1;

	if (nextCount < config.consecutiveFailureThreshold) {
		return {
			state: { ...state, consecutiveFailures: nextCount },
			decision: { kind: 'increment-failure-count', newCount: nextCount },
		};
	}

	const cooldownActive = state.lastSwitchAt !== null && (now - state.lastSwitchAt) < config.switchCooldownMs;
	if (cooldownActive) {
		return {
			state: { ...state, consecutiveFailures: nextCount },
			decision: { kind: 'increment-failure-count', newCount: nextCount },
		};
	}

	const nextProviderId = pickNextInChain(state.currentProviderId, config.chain);
	if (nextProviderId === undefined) {
		return {
			state: { ...state, consecutiveFailures: nextCount },
			decision: { kind: 'chain-exhausted', lastTriedProviderId: state.currentProviderId },
		};
	}

	return {
		state: { currentProviderId: nextProviderId, consecutiveFailures: 0, lastSwitchAt: now },
		decision: { kind: 'switch', from: state.currentProviderId, to: nextProviderId, reason: 'consecutive-failures' },
	};
}

function pickNextInChain(current: string, chain: ReadonlyArray<string>): string | undefined {
	const idx = chain.indexOf(current);
	if (idx < 0) {
		// `current` not in the chain → start from the head.
		return chain[0];
	}
	if (idx + 1 >= chain.length) {
		return undefined;
	}
	return chain[idx + 1];
}
