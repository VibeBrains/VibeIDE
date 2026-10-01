/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VibeHttpRunReport } from '../../common/httpApi/vibeHttpApiTypes.js';
import { MAX_TRACKED_RUNS, RUN_TTL_AFTER_FINISH_MS, RUN_TTL_UNFINISHED_MS, VibeHttpRunRegistry } from '../../common/httpApi/vibeHttpRunRegistry.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function run(over: Partial<VibeHttpRunReport> = {}): VibeHttpRunReport {
	return { requestId: 'r1', instanceId: 'w1', sessionId: 's1', status: 'running', ...over };
}

function registryAt(start: number): { readonly registry: VibeHttpRunRegistry; advance(ms: number): void } {
	let now = start;
	return { registry: new VibeHttpRunRegistry(() => now), advance: ms => { now += ms; } };
}

suite('vibeHttpRunRegistry', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a run is followed from start to finish with its answer and times', () => {
		const { registry, advance } = registryAt(T0);
		registry.report(run());
		advance(5_000);
		registry.report(run({ status: 'awaiting_approval' }));
		advance(5_000);
		registry.report(run({ status: 'completed', answer: 'готово', answerTruncated: true }));
		assert.deepStrictEqual(registry.get('s1'), {
			sessionId: 's1',
			status: 'completed',
			answer: 'готово',
			answerTruncated: true,
			startedAt: iso(T0),
			updatedAt: iso(T0 + 10_000),
			finishedAt: iso(T0 + 10_000),
		});
	});

	test('a terminal status never reverts, but a new request on the session starts over', () => {
		const { registry, advance } = registryAt(T0);
		registry.report(run({ status: 'failed', error: 'нет модели' }));
		advance(1_000);
		registry.report(run({ status: 'running' }));
		const afterLateWord = registry.get('s1');
		advance(1_000);
		registry.report(run({ requestId: 'r2', status: 'running' }));
		assert.deepStrictEqual([afterLateWord?.status, afterLateWord?.error, registry.get('s1')], [
			'failed',
			'нет модели',
			{ sessionId: 's1', status: 'running', startedAt: iso(T0 + 2_000), updatedAt: iso(T0 + 2_000) },
		]);
	});

	test('a finished run is kept for an hour, an unfinished one for a day', () => {
		const { registry, advance } = registryAt(T0);
		registry.report(run({ sessionId: 'done', status: 'completed' }));
		registry.report(run({ sessionId: 'stuck', requestId: 'r2' }));
		advance(RUN_TTL_AFTER_FINISH_MS);
		const atHour = [registry.get('done')?.status, registry.get('stuck')?.status];
		advance(1);
		const pastHour = [registry.get('done')?.status, registry.get('stuck')?.status];
		advance(RUN_TTL_UNFINISHED_MS - RUN_TTL_AFTER_FINISH_MS);
		const pastDay = [registry.get('done')?.status, registry.get('stuck')?.status];
		assert.deepStrictEqual([atHour, pastHour, pastDay], [
			['completed', 'running'],
			[undefined, 'running'],
			[undefined, undefined],
		]);
	});

	test('past the ceiling the least recently updated session goes', () => {
		const { registry, advance } = registryAt(T0);
		for (let i = 0; i < MAX_TRACKED_RUNS; i++) {
			registry.report(run({ sessionId: `s${i}`, requestId: `r${i}` }));
			advance(1);
		}
		// Touching the oldest keeps it; the next oldest is the one evicted
		registry.report(run({ sessionId: 's0', requestId: 'r0', status: 'awaiting_approval' }));
		advance(1);
		registry.report(run({ sessionId: 'new', requestId: 'rn' }));
		assert.deepStrictEqual(
			[registry.get('s0')?.status, registry.get('s1'), registry.get('s2')?.status, registry.get('new')?.status],
			['awaiting_approval', undefined, 'running', 'running'],
		);
	});

	test('a window that went away fails its unfinished runs and leaves the rest alone', () => {
		const { registry, advance } = registryAt(T0);
		registry.report(run({ sessionId: 'a', requestId: 'ra', instanceId: 'gone' }));
		registry.report(run({ sessionId: 'b', requestId: 'rb', instanceId: 'gone', status: 'completed' }));
		registry.report(run({ sessionId: 'c', requestId: 'rc', instanceId: 'alive' }));
		advance(1_000);
		registry.failRunsOf('gone', 'окно закрыто');
		assert.deepStrictEqual(
			['a', 'b', 'c'].map(id => {
				const s = registry.get(id);
				return [s?.status, s?.error, s?.finishedAt];
			}),
			[
				['failed', 'окно закрыто', iso(T0 + 1_000)],
				['completed', undefined, iso(T0)],
				['running', undefined, undefined],
			],
		);
	});
});
