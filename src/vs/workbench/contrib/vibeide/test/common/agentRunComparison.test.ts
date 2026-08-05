/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentRunRecord } from '../../common/agentRunLedger.js';
import { compareRuns, renderRunComparisonMarkdown } from '../../common/agentRunComparison.js';

function record(overrides: Partial<AgentRunRecord> & { runId: string }): AgentRunRecord {
	return {
		epoch: 'epoch-a',
		fence: { windowStartedAtMs: 1, seq: 1 },
		role: 'explore',
		goal: 'найти обработчик',
		parentThreadId: 'thread-1',
		status: 'completed',
		startedAt: 1_000_000,
		endedAt: 1_060_000,
		tokensUsed: 40_000,
		stepsDone: 12,
		model: 'claude-opus-5',
		...overrides,
	};
}

const ORIGINAL = record({ runId: 'run-original' });

suite('agentRunComparison — the same goal on another model', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('deltas are computed per dimension and describe the outcome, not just the sign', () => {
		const replay = record({ runId: 'run-replay', tokensUsed: 30_000, stepsDone: 12, endedAt: 1_090_000, model: 'claude-sonnet-5' });
		const comparison = compareRuns(ORIGINAL, replay, { originalUsd: 0.6, replayUsd: 0.12 });

		assert.deepStrictEqual(
			comparison.dimensions.map(d => [d.label, d.delta, d.unavailable]),
			[
				['Токены', -10_000, false],
				['Шаги', 0, false],
				['Время', 30, false],
				['Стоимость', -0.48, false],
			],
		);
	});

	test('a missing measurement is unavailable, never a delta against zero', () => {
		const replay = record({ runId: 'run-replay', stepsDone: undefined, endedAt: undefined });
		const comparison = compareRuns(ORIGINAL, replay);

		assert.deepStrictEqual(
			comparison.dimensions.map(d => [d.label, d.unavailable, d.delta]),
			[
				['Токены', false, 0],
				['Шаги', true, undefined],
				['Время', true, undefined],
				// Cost was never supplied by the caller.
				['Стоимость', true, undefined],
			],
		);
	});

	test('a comparison against an unfinished run is flagged, because cheaper may just mean stopped', () => {
		const stopped = record({ runId: 'run-replay', status: 'stopped', tokensUsed: 5_000 });
		const markdown = renderRunComparisonMarkdown(compareRuns(ORIGINAL, stopped, { originalUsd: 0.6, replayUsd: 0.1 }));

		assert.deepStrictEqual(
			[
				compareRuns(ORIGINAL, stopped).bothSucceeded,
				markdown.includes('не завершился успешно'),
				// Every dimension was measurable here, so nothing may claim otherwise — the warning
				// above is what tells the reader the cheaper number is not a better result.
				markdown.includes('нельзя сравнить'),
			],
			[false, true, false],
		);
	});

	test('the verdict word matches the unit — only money is «дороже»', () => {
		// Caught by the live smoke: elapsed time was reported as «+3 с (+9%) — дороже», about
		// seconds nobody paid for.
		const replay = record({ runId: 'run-replay', tokensUsed: 50_000, stepsDone: 9, endedAt: 1_090_000 });
		const markdown = renderRunComparisonMarkdown(compareRuns(ORIGINAL, replay, { originalUsd: 0.6, replayUsd: 0.9 }));

		assert.deepStrictEqual(
			['больше', 'меньше', 'медленнее', 'дороже'].map(word => markdown.includes(`— ${word}`)),
			[true, true, true, true],
		);
	});

	test('report states plainly that a replay re-does the work rather than replaying steps', () => {
		const markdown = renderRunComparisonMarkdown(compareRuns(ORIGINAL, record({ runId: 'run-replay' })));
		assert.deepStrictEqual(
			[
				markdown.includes('выполняет задачу заново'),
				markdown.includes('она сделает это ещё раз'),
				markdown.includes('без изменений'),
			],
			[true, true, true],
		);
	});
});
