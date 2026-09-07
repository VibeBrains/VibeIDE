/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { PlanStep } from '../chatThreadServiceTypes.js';

/**
 * Перенос шагов плана в реестр задач — чистое преобразование, без сервисов.
 *
 * WHY the bridge is needed: a plan lives inside a chat thread and dies with it, while the register
 * survives a restart. Today that means the same work exists twice in two lifetimes — and the half
 * that is unfinished is exactly the half that lives in the shorter one.
 *
 * WHY it is one-directional: a plan is the model's account of what it intends to do next, and a task
 * is a commitment that outlives the conversation. Writing back would make an abandoned conversation
 * rewrite the register, which is the wrong way round.
 */

export interface PlanTaskRequest {
	readonly title: string;
	/** Index of the step this task came from, so the caller can wire dependencies by position. */
	readonly stepNumber: number;
	/** Steps this one follows, expressed by their numbers — resolved to task ids by the caller. */
	readonly afterStepNumbers: readonly number[];
}

/**
 * Steps worth carrying over: everything not already finished.
 *
 * A succeeded step is history, and history belongs to the transcript. A skipped one was decided
 * against, and reviving it as a task would quietly undo that decision. Everything else — queued,
 * running, failed, paused — is unfinished work, which is the whole point of moving it somewhere that
 * lasts.
 */
const CARRIED_OVER: ReadonlySet<string> = new Set(['queued', 'running', 'failed', 'paused']);

/**
 * Turn a plan into task requests, in order.
 *
 * Dependencies follow the plan's own sequence: step N waits for the carried-over step before it.
 * Steps are ordered on purpose in a plan, and dropping that order would turn a sequence into a pile.
 * A step skipped over (already finished) does not become an intermediate link — the next live step
 * waits for the last live one, not for something that will never be created.
 */
export function planToTaskRequests(steps: readonly PlanStep[]): PlanTaskRequest[] {
	const out: PlanTaskRequest[] = [];
	let previousLive: number | undefined;

	for (const step of steps) {
		if (step.disabled || (step.status && !CARRIED_OVER.has(step.status))) {
			continue;
		}
		const title = step.description?.trim();
		if (!title) {
			// A step with no description carries nothing a person could act on later.
			continue;
		}
		out.push({
			title,
			stepNumber: step.stepNumber,
			afterStepNumbers: previousLive === undefined ? [] : [previousLive],
		});
		previousLive = step.stepNumber;
	}
	return out;
}
