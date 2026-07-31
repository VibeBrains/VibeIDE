/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure decision logic for the VERIFY-GATE (see docs/knowledge/runtimeQuirks/verifyGate.md).
 * Kept free of any I/O so it is unit-testable in isolation from the terminal run.
 */

export type VerifyGateMode = 'off' | 'warn' | 'enforce';

/**
 * What the agent loop should do at `vibe_complete` given the verify outcome:
 * - `complete`       — finish the turn normally (gate inert, or verify passed).
 * - `warn-complete`  — verify failed but mode is `warn`: note it, still finish.
 * - `bounce`         — verify failed in `enforce` and attempts remain: send the model back to fix.
 * - `stop`           — verify failed in `enforce` and attempts are exhausted: halt and hand to the user.
 */
export type VerifyGateDecision = 'complete' | 'warn-complete' | 'bounce' | 'stop';

export interface VerifyGateInput {
	readonly mode: VerifyGateMode;
	/** Whether a verify command actually ran (command configured AND the turn mutated files). */
	readonly verified: boolean;
	/** Verify exit code was 0. Meaningless when `verified` is false. */
	readonly passed: boolean;
	/** How many times the gate has already bounced the model on this run. */
	readonly attemptsUsed: number;
	/** Ceiling on bounces before the run is stopped (`vibeide.agent.verifyGate.maxAttempts`). */
	readonly maxAttempts: number;
}

/**
 * Decide the gate action. Off/inert/passed → `complete`. In `warn`, a red verify still completes
 * (with a note). In `enforce`, a red verify bounces the model until `maxAttempts` is reached, then
 * stops the run so an unfixable failure cannot loop forever.
 */
export function decideVerifyGate(input: VerifyGateInput): VerifyGateDecision {
	const { mode, verified, passed, attemptsUsed, maxAttempts } = input;
	if (mode === 'off' || !verified || passed) {
		return 'complete';
	}
	// verify ran and failed
	if (mode === 'warn') {
		return 'warn-complete';
	}
	// enforce
	return attemptsUsed < Math.max(1, maxAttempts) ? 'bounce' : 'stop';
}
