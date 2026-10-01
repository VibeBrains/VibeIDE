/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VibeHookDecision } from '../hooks/hookOutcome.js';
import { PipelineStepOutcome, shouldRunStep, VibePipelineStep } from './vibePipelineFile.js';

/**
 * The gate of the cascade written as separate steps
 * What `pipelineStepEnd` said about a step, and which `escalation` step that spares
 *
 * The rules are VibeIDEA's (`runStepGate`, `runStep`), so the shared `pipelines.json` costs the same in both products:
 * - the hook is asked after every successful step; a failed, stopped or skipped step has no verdict;
 * - no verdict (no hook, hooks off, only broken hooks) is not «accepted»: with nothing to accept by, escalation runs;
 * - a verdict belongs to the step it judged, and the step after it consumes it, whatever that step is
 *
 * One deliberate difference: a step the gate skipped hands the verdict on
 * A ladder cheap → mid → expensive then skips both rungs on one «accepted»
 * VibeIDEA drops the verdict there and runs the expensive rung
 *
 * Pure: decisions and outcomes in, verdicts out.
 */

/** `true` — accepted, `false` — refused, `undefined` — nothing judged the result. */
export type GateVerdict = boolean | undefined;

/** The gate's word on one step from the decision of its `pipelineStepEnd` hooks. */
export function gateVerdictOf(decision: Pick<VibeHookDecision, 'blocked' | 'ran'>): GateVerdict {
	if (decision.blocked) {
		return false;
	}
	return decision.ran ? true : undefined;
}

/** After a wave: accepted when every member that was judged was; no member judged — no verdict. */
export function waveVerdict(verdicts: readonly GateVerdict[]): GateVerdict {
	const judged = verdicts.filter((verdict): verdict is boolean => verdict !== undefined);
	return judged.length === 0 ? undefined : judged.every(verdict => verdict);
}

/** Whether the gate spares this step: it is an `escalation` step, and the result before it was accepted. */
export function skipsByGate(step: Pick<VibePipelineStep, 'escalation'>, verdict: GateVerdict): boolean {
	return step.escalation === true && verdict === true;
}

/** How a step that was not taken from an interrupted run starts: it runs, or is skipped and why. */
export type StepStart = 'run' | 'skipAfterFailure' | 'skipByGate';

/**
 * Whether the step runs, given the steps before it and the verdict it inherits
 *
 * A failure is checked first: an `escalation` step after a failed draft is skipped as any other step would be,
 * Unless it says `continueOnFailure` — a gate judges results, and a failed step has none
 */
export function stepStart(step: VibePipelineStep, before: readonly PipelineStepOutcome[], verdict: GateVerdict): StepStart {
	if (!shouldRunStep(step, before)) {
		return 'skipAfterFailure';
	}
	return skipsByGate(step, verdict) ? 'skipByGate' : 'run';
}

/** One finished member of a group, with what the gate said about it. */
export interface GatedOutcome {
	readonly outcome: PipelineStepOutcome;
	/**
	 * The gate on the step's own result
	 * `undefined` for a step that failed, did not run, or was taken over from an interrupted run
	 */
	readonly verdict: GateVerdict;
}

/**
 * The verdict the next group starts with
 *
 * A step the gate skipped hands on the verdict it was skipped on: nothing new was judged,
 * And dropping it would run the next rung of a ladder after the cheaper one was accepted
 * Anything else — a step that ran, failed or was skipped after a failure, a wave — replaces it with its own
 */
export function verdictAfterGroup(before: GateVerdict, group: readonly GatedOutcome[]): GateVerdict {
	if (group.length === 1 && group[0].outcome.skippedByGate) {
		return before;
	}
	return waveVerdict(group.map(member => member.verdict));
}
