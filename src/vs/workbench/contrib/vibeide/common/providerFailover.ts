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
	/**
	 * The provider refused the credential itself (401/403): key revoked, plan cancelled, access to
	 * the model withdrawn. Unlike other 4xx this does NOT get better on retry and does NOT reset the
	 * failure count — waiting for three of them means three dead requests in a row for a provider
	 * that will never answer again. (OpenAI withdrew Cursor's model access on two weeks' notice in
	 * August 2026; a user whose key is cut off sees exactly this.)
	 */
	| 'auth-revoked'
	| 'cancelled';

export interface ProviderHealthState {
	currentProviderId: string;
	consecutiveFailures: number;
	lastSwitchAt: number | null;
}

export interface FailoverConfig {
	chain: ReadonlyArray<string>;
	consecutiveFailureThreshold: number;
	/**
	 * How many refused credentials before switching. One by default: a revoked key is a verdict,
	 * not a hiccup — retrying it only spends the user's time. Raise it if a provider is known to
	 * answer 401 while a token refreshes.
	 */
	authFailureThreshold: number;
	/** Min ms between switches — protects against ping-pong when every provider is down. */
	switchCooldownMs: number;
}

export const FAILOVER_DEFAULTS: FailoverConfig = {
	chain: [],
	consecutiveFailureThreshold: 3,
	authFailureThreshold: 1,
	switchCooldownMs: 30_000,
};

export type FailoverDecision =
	| { kind: 'no-op' }
	| { kind: 'reset-failure-count' }
	| { kind: 'increment-failure-count'; newCount: number }
	| { kind: 'switch'; from: string; to: string; reason: 'consecutive-failures' | 'auth-revoked' }
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
		// A plain 4xx is a bad request, not a dead provider — resetting keeps one malformed call
		// from counting towards an outage. `auth-revoked` is deliberately NOT in this branch.
		if (state.consecutiveFailures === 0) {
			return { state, decision: { kind: 'no-op' } };
		}
		return {
			state: { ...state, consecutiveFailures: 0 },
			decision: { kind: 'reset-failure-count' },
		};
	}

	const nextCount = state.consecutiveFailures + 1;
	const threshold = outcome === 'auth-revoked'
		? Math.max(1, config.authFailureThreshold)
		: config.consecutiveFailureThreshold;

	if (nextCount < threshold) {
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
		decision: {
			kind: 'switch',
			from: state.currentProviderId,
			to: nextProviderId,
			reason: outcome === 'auth-revoked' ? 'auth-revoked' : 'consecutive-failures',
		},
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
