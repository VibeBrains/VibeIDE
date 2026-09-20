/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SubagentEntry, SubagentStatus, continuationRefusal, findLiveRunByIdempotencyKey } from '../../common/vibeSubagentService.js';

function entry(id: string, status: SubagentStatus, idempotencyKey?: string): SubagentEntry {
	return {
		id,
		type: 'explore',
		status,
		parentThreadId: 'thread-1',
		startedAt: 1_000,
		handoff: { parentThreadId: 'thread-1', type: 'explore', goal: 'найти X', idempotencyKey },
	};
}

suite('subagent idempotency — the same key must not buy a second run', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a live run is reused; a finished one releases the key; an unknown key starts fresh', () => {
		const registry = [
			entry('run-pending', 'pending', 'step-7'),
			entry('run-running', 'running', 'step-8'),
			entry('run-done', 'completed', 'step-9'),
			entry('run-failed', 'failed', 'step-10'),
			entry('run-stopped', 'stopped', 'step-11'),
			entry('run-disposed', 'disposed', 'step-12'),
			entry('run-nokey', 'running'),
		];

		assert.deepStrictEqual(
			[
				findLiveRunByIdempotencyKey(registry, 'step-7'),
				findLiveRunByIdempotencyKey(registry, 'step-8'),
				findLiveRunByIdempotencyKey(registry, 'step-9'),
				findLiveRunByIdempotencyKey(registry, 'step-10'),
				findLiveRunByIdempotencyKey(registry, 'step-11'),
				findLiveRunByIdempotencyKey(registry, 'step-12'),
				findLiveRunByIdempotencyKey(registry, 'never-used'),
				findLiveRunByIdempotencyKey(registry, ''),
				findLiveRunByIdempotencyKey([], 'step-7'),
			],
			['run-pending', 'run-running', undefined, undefined, undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('the first live match wins, so a retry always lands on the run already working', () => {
		const registry = [
			entry('first', 'running', 'same-key'),
			entry('second', 'pending', 'same-key'),
		];
		assert.strictEqual(findLiveRunByIdempotencyKey(registry, 'same-key'), 'first');
	});
});

suite('subagent continuation — a rework goes to the author, or fails loudly', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a finished run of the same role with a kept conversation can be continued', () => {
		const done: SubagentEntry = { ...entry('run-done', 'completed'), type: 'backend-dev', result: { subagentId: 'run-done', status: 'success', summary: 'готово', tokensUsed: 1 } };
		const running: SubagentEntry = { ...entry('run-live', 'running'), type: 'backend-dev' };
		const ask = { type: 'backend-dev' as const, continuesRunId: 'run-done' };
		assert.deepStrictEqual([
			continuationRefusal({ type: 'backend-dev' }, undefined, false),
			continuationRefusal(ask, done, true),
			continuationRefusal(ask, undefined, false),
			continuationRefusal({ type: 'qa', continuesRunId: 'run-done' }, done, true),
			continuationRefusal({ type: 'backend-dev', continuesRunId: 'run-live' }, running, true),
			continuationRefusal(ask, done, false),
		], [
			undefined,
			undefined,
			'Продолжить прогон run-done нельзя: он уже освобождён.',
			'Продолжить прогон run-done нельзя: это роль «backend-dev», а не «qa».',
			'Продолжить прогон run-live нельзя: он ещё не закончился.',
			'Продолжить прогон run-done нельзя: его переписка не сохранялась.',
		]);
	});
});
