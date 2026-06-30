/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Cost-forecast confirm decision (926) — pure helper.
 *
 * `VibeTokenCostForecastService` already estimates the price of an
 * outgoing request. This helper is the policy: should the runtime show
 * a confirm dialog before sending? The decision considers:
 *   - the user's `vibeide.cost.confirmThreshold` (default $0.50)
 *   - the user's `vibeide.cost.confirmTokenThreshold` (default 50_000)
 *   - whether the user already approved a similar forecast this session
 *   - whether `vibeide.cost.alwaysConfirm = true` overrides everything
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface CostForecast {
	/** Estimated total cost in USD. */
	estimatedUSD: number;
	/** Estimated total tokens (input + output). */
	estimatedTokens: number;
	/** Provider id — used for the session-approval bucket. */
	provider: string;
	/** Model id — used for the session-approval bucket. */
	modelId: string;
}

export interface CostForecastConfig {
	confirmUSDThreshold: number;
	confirmTokenThreshold: number;
	alwaysConfirm: boolean;
	/** Per-session approval cache: any (provider, modelId) the user already
	 * confirmed at-or-below this cost gets a free pass. */
	sessionApprovals: ReadonlyArray<{ provider: string; modelId: string; approvedUpToUSD: number }>;
}

export const COST_FORECAST_DEFAULTS: CostForecastConfig = {
	confirmUSDThreshold: 0.5,
	confirmTokenThreshold: 50_000,
	alwaysConfirm: false,
	sessionApprovals: [],
};

export type CostConfirmDecision =
	| { kind: 'auto-allow'; reason: 'under-thresholds' | 'session-approved' }
	| { kind: 'require-confirm'; reason: 'over-usd' | 'over-tokens' | 'always-confirm' };

/**
 * Decide whether the runtime needs a confirm dialog. Pure.
 *
 * Decision priority:
 *   1. config.alwaysConfirm = true → require-confirm(always-confirm)
 *   2. session-approval cache hit (same provider+modelId, current
 *      forecast ≤ approved cap) → auto-allow(session-approved)
 *   3. estimatedUSD > confirmUSDThreshold → require-confirm(over-usd)
 *   4. estimatedTokens > confirmTokenThreshold → require-confirm(over-tokens)
 *   5. otherwise → auto-allow(under-thresholds)
 */
export function decideCostConfirm(
	forecast: CostForecast,
	config: CostForecastConfig = COST_FORECAST_DEFAULTS,
): CostConfirmDecision {
	if (config.alwaysConfirm) {
		return { kind: 'require-confirm', reason: 'always-confirm' };
	}

	const sessionHit = config.sessionApprovals.find(a =>
		a.provider === forecast.provider
		&& a.modelId === forecast.modelId
		&& forecast.estimatedUSD <= a.approvedUpToUSD,
	);
	if (sessionHit) {
		return { kind: 'auto-allow', reason: 'session-approved' };
	}

	if (forecast.estimatedUSD > config.confirmUSDThreshold) {
		return { kind: 'require-confirm', reason: 'over-usd' };
	}
	if (forecast.estimatedTokens > config.confirmTokenThreshold) {
		return { kind: 'require-confirm', reason: 'over-tokens' };
	}
	return { kind: 'auto-allow', reason: 'under-thresholds' };
}

/**
 * Render the modal body shown when the decision requires confirmation.
 * Pure. Returns `''` when auto-allowed.
 */
export function describeCostDecision(
	forecast: CostForecast,
	decision: CostConfirmDecision,
): string {
	if (decision.kind === 'auto-allow') { return ''; }
	const usd = forecast.estimatedUSD.toFixed(2);
	const tokens = forecast.estimatedTokens.toLocaleString('en-US');
	switch (decision.reason) {
		case 'over-usd':
			return `This request will cost approximately $${usd} (${tokens} tokens) on \`${forecast.provider}/${forecast.modelId}\`.`;
		case 'over-tokens':
			return `This request will use ~${tokens} tokens (≈$${usd}) on \`${forecast.provider}/${forecast.modelId}\`.`;
		case 'always-confirm':
			return `Cost confirm is set to "always". This request: ~$${usd} / ${tokens} tokens.`;
	}
}
