/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAgentDailyDigest, formatAgentDailyDigest } from '../../common/agentDailyDigest.js';
import { AgentRunRecord } from '../../common/agentRunLedger.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function run(over: Partial<AgentRunRecord>): AgentRunRecord {
	return {
		runId: 'r', epoch: 'e', fence: { windowStartedAtMs: NOW - DAY, seq: 1 },
		role: 'coder', goal: 'сделать дело', parentThreadId: 't',
		status: 'completed', startedAt: NOW - 3600_000, endedAt: NOW - 3000_000,
		...over,
	} as AgentRunRecord;
}

suite('Agent daily digest', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('failures are named, successes counted, older runs left out', () => {
		const digest = buildAgentDailyDigest([
			run({ runId: 'ok1' }),
			run({ runId: 'ok2' }),
			run({ runId: 'bad', status: 'failed', goal: 'починить тесты', failureReason: 'provider 429' }),
			run({ runId: 'cut', status: 'stopped', stopCode: 'max-steps', goal: 'пересобрать индекс' }),
			run({ runId: 'live', status: 'running', endedAt: undefined, lastSeenAt: NOW - 60_000 }),
			// Yesterday's run, finished before the window opened.
			run({ runId: 'old', startedAt: NOW - 3 * DAY, endedAt: NOW - 2 * DAY }),
		], { fromMs: NOW - DAY, toMs: NOW });

		const text = formatAgentDailyDigest(digest)!;
		assert.deepStrictEqual(
			{
				total: digest.total,
				failed: digest.failed.map(r => r.runId),
				limited: digest.limited.map(r => r.runId),
				succeeded: digest.succeeded,
				stillRunning: digest.stillRunning,
				namesFailure: text.includes('починить тесты') && text.includes('provider 429'),
				// A success is a number, not a line — twenty green runs must not bury the red one.
				namesSuccess: text.includes('сделать дело'),
				warns: text.startsWith('⚠️'),
			},
			{
				total: 5,
				failed: ['bad'],
				limited: ['cut'],
				succeeded: 2,
				stillRunning: 1,
				namesFailure: true,
				namesSuccess: false,
				warns: true,
			},
		);
	});

	test('a quiet day says nothing rather than sending an empty template', () => {
		const digest = buildAgentDailyDigest([run({ startedAt: NOW - 5 * DAY, endedAt: NOW - 5 * DAY })], { fromMs: NOW - DAY, toMs: NOW });
		assert.deepStrictEqual(
			{ total: digest.total, text: formatAgentDailyDigest(digest) },
			{ total: 0, text: undefined },
		);
	});

	test('all-green day reports plainly, without a warning sign', () => {
		const digest = buildAgentDailyDigest([run({ runId: 'a' }), run({ runId: 'b', tokensUsed: 1500, artifacts: ['src/a.ts'] })], { fromMs: NOW - DAY, toMs: NOW });
		const text = formatAgentDailyDigest(digest)!;
		assert.deepStrictEqual(
			{ starts: text.startsWith('✅'), mentionsTokens: text.includes('1'), mentionsFiles: text.includes('затронуто файлов 1') },
			{ starts: true, mentionsTokens: true, mentionsFiles: true },
		);
	});

	test('a late digest says how long it actually covers, instead of claiming a day', () => {
		const headline = (fromMs: number) =>
			formatAgentDailyDigest(buildAgentDailyDigest([run({})], { fromMs, toMs: NOW }))!.split('\n')[0];

		// The header is the only place the reader learns the span. A digest delivered days late
		// still said "за сутки" before this — a claim the reader has no way to check.
		assert.deepStrictEqual(
			[DAY, DAY + 5 * 3600_000, 2 * DAY, 5 * DAY, 21 * DAY].map(span => headline(NOW - span)),
			[
				'✅ Сводка за сутки: 1 прогонов, всё прошло без срывов.',
				'✅ Сводка за сутки: 1 прогонов, всё прошло без срывов.',
				'✅ Сводка за 2 дня: 1 прогонов, всё прошло без срывов.',
				'✅ Сводка за 5 дней: 1 прогонов, всё прошло без срывов.',
				'✅ Сводка за 21 день: 1 прогонов, всё прошло без срывов.',
			],
		);
	});
});
