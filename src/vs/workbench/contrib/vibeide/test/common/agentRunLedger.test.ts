/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AgentRunRecord, compactAgentRunLog, markOrphanedRuns, parseAgentRunLog, pruneAgentRuns,
	serializeAgentRunUpdate, summariseAgentRuns,
} from '../../common/agentRunLedger.js';

const FENCE = { windowStartedAtMs: 1_000, seq: 1 };
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000;

function run(overrides: Partial<AgentRunRecord> & { runId: string }): AgentRunRecord {
	return {
		epoch: 'epoch-a',
		fence: FENCE,
		role: 'explore',
		goal: 'найти обработчик авторизации',
		parentThreadId: 'thread-1',
		status: 'running',
		startedAt: NOW - DAY_MS,
		...overrides,
	};
}

suite('agentRunLedger — durable record of agent runs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('fold: later updates win, junk and never-completed runs count as malformed', () => {
		const log = [
			serializeAgentRunUpdate(run({ runId: 'run-1' })),
			serializeAgentRunUpdate({ runId: 'run-1', status: 'completed', endedAt: NOW, tokensUsed: 120, summary: 'нашёл' }),
			'не json вовсе',
			'{"runId":"run-2","status":"running"}',
			'',
		].join('\n');

		assert.deepStrictEqual(parseAgentRunLog(log), {
			records: [run({ runId: 'run-1', status: 'completed', endedAt: NOW, tokensUsed: 120, summary: 'нашёл' })],
			malformedLines: 2,
		});
	});

	test('roundtrip: compacting and re-reading the log preserves records', () => {
		const records = [run({ runId: 'run-1', status: 'completed', endedAt: NOW }), run({ runId: 'run-2' })];
		assert.deepStrictEqual(parseAgentRunLog(compactAgentRunLog(records)), { records, malformedLines: 0 });
	});

	test('orphaning: only a silent foreign window is abandoned — a live second window is left alone', () => {
		const records = [
			run({ runId: 'own-live', epoch: 'epoch-now' }),
			run({ runId: 'foreign-silent', epoch: 'epoch-old', lastSeenAt: NOW - 90_000 }),
			run({ runId: 'foreign-beating', epoch: 'epoch-other', lastSeenAt: NOW - 5_000 }),
			run({ runId: 'foreign-done', epoch: 'epoch-old', status: 'completed', endedAt: 42 }),
		];

		assert.deepStrictEqual(markOrphanedRuns(records, 'epoch-now', NOW, 60_000), {
			records: [
				run({ runId: 'own-live', epoch: 'epoch-now' }),
				run({ runId: 'foreign-silent', epoch: 'epoch-old', lastSeenAt: NOW - 90_000, status: 'orphaned', endedAt: NOW }),
				run({ runId: 'foreign-beating', epoch: 'epoch-other', lastSeenAt: NOW - 5_000 }),
				run({ runId: 'foreign-done', epoch: 'epoch-old', status: 'completed', endedAt: 42 }),
			],
			orphanedIds: ['foreign-silent'],
		});
	});

	test('prune: retention drops old terminal runs, count keeps the newest, live runs always stay', () => {
		const records = [
			run({ runId: 'old-done', status: 'completed', endedAt: NOW - 3 * DAY_MS }),
			run({ runId: 'live-old' }),
			run({ runId: 'done-1', status: 'completed', endedAt: NOW - 3_000 }),
			run({ runId: 'done-2', status: 'failed', endedAt: NOW - 2_000 }),
			run({ runId: 'done-3', status: 'stopped', endedAt: NOW - 1_000 }),
		];

		assert.deepStrictEqual(
			[
				pruneAgentRuns(records, { maxRecords: 100, retentionDays: 1, now: NOW }).map(r => r.runId),
				pruneAgentRuns(records, { maxRecords: 3, retentionDays: 0, now: NOW }).map(r => r.runId),
				pruneAgentRuns(records, { maxRecords: 1, retentionDays: 0, now: NOW }).map(r => r.runId),
			],
			[
				['live-old', 'done-1', 'done-2', 'done-3'],
				['live-old', 'done-2', 'done-3'],
				['live-old'],
			],
		);
	});

	test('summary: counts live, orphaned, failed, limit-stopped and total tokens', () => {
		const records = [
			run({ runId: 'a' }),
			run({ runId: 'b', status: 'orphaned', endedAt: NOW }),
			run({ runId: 'c', status: 'failed', endedAt: NOW, tokensUsed: 10 }),
			run({ runId: 'd', status: 'stopped', endedAt: NOW, stopCode: 'token-budget', tokensUsed: 90 }),
			run({ runId: 'e', status: 'stopped', endedAt: NOW, stopCode: 'cancelled' }),
		];

		assert.deepStrictEqual(summariseAgentRuns(records), {
			total: 5, live: 1, orphaned: 1, failed: 1, limited: 1, tokensTotal: 100,
		});
	});
});
