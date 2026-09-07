/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { planToTaskRequests } from '../../common/taskLedger/planToTasks.js';
import type { PlanStep } from '../../common/chatThreadServiceTypes.js';

/**
 * Перенос шагов плана в реестр.
 *
 * The bridge exists because a plan dies with its thread while the register does not — so what is
 * carried over, and what is deliberately left behind, is the whole design. Two mistakes would be
 * silent: reviving work that was decided against, and losing the order the plan was written in.
 */
suite('plan to tasks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const step = (stepNumber: number, description: string, over: Partial<PlanStep> = {}): PlanStep =>
		({ stepNumber, description, ...over }) as PlanStep;

	test('only unfinished steps are carried over', () => {
		const requests = planToTaskRequests([
			step(1, 'уже сделано', { status: 'succeeded' }),
			step(2, 'в работе', { status: 'running' }),
			step(3, 'отклонено', { status: 'skipped' }),
			step(4, 'упало', { status: 'failed' }),
			step(5, 'выключено рукой', { disabled: true }),
			step(6, 'ещё не начато'),
		]);
		assert.deepStrictEqual(requests.map(r => r.title), ['в работе', 'упало', 'ещё не начато']);
	});

	/**
	 * A plan is a sequence. Dropping the order would turn it into a pile, and the register would let
	 * the last step start first.
	 */
	test('order becomes dependencies, skipping over finished steps', () => {
		const requests = planToTaskRequests([
			step(1, 'первый'),
			step(2, 'уже сделан', { status: 'succeeded' }),
			step(3, 'третий'),
		]);
		assert.deepStrictEqual(requests, [
			{ title: 'первый', stepNumber: 1, afterStepNumbers: [] },
			// Waits for step 1, not for step 2: step 2 will never become a task to wait for.
			{ title: 'третий', stepNumber: 3, afterStepNumbers: [1] },
		]);
	});

	test('a step with no description carries nothing anyone could act on', () => {
		assert.deepStrictEqual(planToTaskRequests([step(1, '   '), step(2, 'настоящий шаг')]).map(r => r.title), ['настоящий шаг']);
	});

	test('a finished plan produces nothing, and that is an answer', () => {
		assert.deepStrictEqual(planToTaskRequests([step(1, 'а', { status: 'succeeded' }), step(2, 'б', { status: 'succeeded' })]), []);
		assert.deepStrictEqual(planToTaskRequests([]), []);
	});
});
