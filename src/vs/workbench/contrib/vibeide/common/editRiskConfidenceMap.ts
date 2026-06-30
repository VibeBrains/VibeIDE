/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure mapping from edit risk score → diff confidence color (1057).
 *
 * Per AGENTS.md: confidence score and LLM-as-judge are independent. Judge
 * cannot raise confidence to green; risk_score > 0.8 forces red regardless
 * of judge. This module encodes that policy as a pure function so unit
 * tests can pin it without an LLM in the loop.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ConfidenceColor = 'green' | 'yellow' | 'red';

export type LlmJudge = 'safe' | 'unknown' | 'risky';

export interface RiskConfidenceInput {
	/** 0..1 from `editRiskScoringService`. Higher = more dangerous edit. */
	riskScore: number;
	/** Optional LLM judge advisory (advisory-only, cannot upgrade to green). */
	llmJudge?: LlmJudge;
	/**
	 * Optional list of heuristic flags from the diff (auth / password / delete
	 * keywords). Any flag forces red.
	 */
	heuristicFlags?: ReadonlyArray<'auth' | 'password' | 'delete' | 'crypto' | 'env'>;
}

/**
 * Compute the final confidence color from inputs.
 *
 * Decision order:
 *   1. Any heuristic flag → red.
 *   2. risk_score > 0.8 → red.
 *   3. judge = 'risky' → red.
 *   4. risk_score > 0.4 OR judge = 'unknown' → yellow.
 *   5. otherwise → green (judge='safe' or undefined; risk_score ≤ 0.4).
 *
 * Pure — same input always yields the same output.
 */
export function deriveConfidenceColor(input: RiskConfidenceInput): ConfidenceColor {
	const { riskScore, llmJudge, heuristicFlags } = input;
	const r = clampScore(riskScore);
	if (heuristicFlags && heuristicFlags.length > 0) {
		return 'red';
	}
	if (r > 0.8) {
		return 'red';
	}
	if (llmJudge === 'risky') {
		return 'red';
	}
	if (r > 0.4 || llmJudge === 'unknown') {
		return 'yellow';
	}
	return 'green';
}

/**
 * Auto mode is blocked when confidence is red. Returns the explicit reason
 * so the UI can surface "blocked because <reason>" rather than a generic
 * "blocked".
 */
export function isAutoBlockedByConfidence(
	input: RiskConfidenceInput,
): { blocked: false } | { blocked: true; reason: 'risk-high' | 'judge-risky' | 'heuristic-flag' } {
	const { riskScore, llmJudge, heuristicFlags } = input;
	if (heuristicFlags && heuristicFlags.length > 0) {
		return { blocked: true, reason: 'heuristic-flag' };
	}
	if (clampScore(riskScore) > 0.8) {
		return { blocked: true, reason: 'risk-high' };
	}
	if (llmJudge === 'risky') {
		return { blocked: true, reason: 'judge-risky' };
	}
	return { blocked: false };
}

/** Clamp a possibly out-of-range / non-finite score into [0, 1]. */
function clampScore(score: number): number {
	if (typeof score !== 'number' || !Number.isFinite(score)) { return 0; }
	if (score < 0) { return 0; }
	if (score > 1) { return 1; }
	return score;
}

/**
 * Sanity check used by tests / CI: the policy must never return green when
 * any of the high-risk inputs is present. Returns `null` when consistent;
 * otherwise the offending input.
 */
export function auditPolicyConsistency(samples: ReadonlyArray<RiskConfidenceInput>): RiskConfidenceInput | null {
	for (const s of samples) {
		const color = deriveConfidenceColor(s);
		const flagged = (s.heuristicFlags?.length ?? 0) > 0;
		const high = clampScore(s.riskScore) > 0.8;
		const risky = s.llmJudge === 'risky';
		if ((flagged || high || risky) && color !== 'red') {
			return s;
		}
	}
	return null;
}
