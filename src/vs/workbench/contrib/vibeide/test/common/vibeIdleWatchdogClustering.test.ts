/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for `clusterCrashes` / `isRecurringPattern` (roadmap W.37 + W.48).
 *
 * Pure-function helpers — perfect candidate for unit tests since they have no
 * IO and feed the pre-flight notification UX. A regression here would silently
 * hide recurring-bug detection.
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	clusterCrashes,
	isRecurringPattern,
} from '../../common/vibeIdleWatchdogCrashClustering.js';
import type { WatchdogLine } from '../../common/vibeIdleWatchdogTypes.js';

function crash(ts: string, proc: string, reason: string): WatchdogLine {
	return { v: 1, type: 'crash', ts, proc: proc as 'renderer', reason };
}

function sample(ts: string, proc: string, rss: number): WatchdogLine {
	return { v: 1, type: 'sample', ts, proc: proc as 'main', pid: 1, uptimeSec: 10, rss, heapUsed: 1, heapTotal: 2 };
}

suite('Idle Watchdog — crash clustering (W.37 / W.48)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty input → empty clusters', () => {
		assert.deepStrictEqual(clusterCrashes([]), []);
	});

	test('non-crash lines ignored', () => {
		const lines: WatchdogLine[] = [
			sample('2026-05-22T10:00:00.000Z', 'main', 100_000_000),
			sample('2026-05-22T10:05:00.000Z', 'renderer', 200_000_000),
		];
		assert.deepStrictEqual(clusterCrashes(lines), []);
	});

	test('three identical crashes → one cluster with count=3', () => {
		const lines: WatchdogLine[] = [
			crash('2026-05-20T23:56:06.000Z', 'renderer', 'oom'),
			crash('2026-05-21T22:01:00.000Z', 'renderer', 'oom'),
			crash('2026-05-22T23:56:06.000Z', 'renderer', 'oom'),
		];
		const clusters = clusterCrashes(lines);
		assert.strictEqual(clusters.length, 1);
		assert.strictEqual(clusters[0].count, 3);
		assert.strictEqual(clusters[0].proc, 'renderer');
		assert.strictEqual(clusters[0].reason, 'oom');
		assert.strictEqual(clusters[0].lastSeen, '2026-05-22T23:56:06.000Z');
	});

	test('different reasons → separate clusters', () => {
		const lines: WatchdogLine[] = [
			crash('2026-05-22T10:00:00.000Z', 'renderer', 'oom'),
			crash('2026-05-22T11:00:00.000Z', 'renderer', 'killed'),
			crash('2026-05-22T12:00:00.000Z', 'renderer', 'oom'),
		];
		const clusters = clusterCrashes(lines);
		assert.strictEqual(clusters.length, 2);
		const oom = clusters.find(c => c.reason === 'oom');
		const killed = clusters.find(c => c.reason === 'killed');
		assert.strictEqual(oom?.count, 2);
		assert.strictEqual(killed?.count, 1);
	});

	test('different proc → separate clusters even with same reason', () => {
		const lines: WatchdogLine[] = [
			crash('2026-05-22T10:00:00.000Z', 'renderer', 'oom'),
			crash('2026-05-22T11:00:00.000Z', 'gpu', 'oom'),
		];
		const clusters = clusterCrashes(lines);
		assert.strictEqual(clusters.length, 2);
		assert.ok(clusters.every(c => c.count === 1));
	});

	test('isRecurringPattern requires count ≥ 3 by default', () => {
		const clusters = [{ signature: 'renderer|oom|0', count: 2, lastSeen: 'x', proc: 'renderer', reason: 'oom' }];
		assert.strictEqual(isRecurringPattern(clusters, 'renderer|oom|0'), false);
		const recurring = [{ signature: 'renderer|oom|0', count: 5, lastSeen: 'x', proc: 'renderer', reason: 'oom' }];
		assert.strictEqual(isRecurringPattern(recurring, 'renderer|oom|0'), true);
	});

	test('isRecurringPattern respects custom threshold', () => {
		const clusters = [{ signature: 's', count: 2, lastSeen: 'x', proc: 'p', reason: 'r' }];
		assert.strictEqual(isRecurringPattern(clusters, 's', 2), true);
		assert.strictEqual(isRecurringPattern(clusters, 's', 3), false);
	});

	test('unknown reason coalesces into `unknown` bucket', () => {
		const lines: WatchdogLine[] = [
			{ v: 1, type: 'crash', ts: 'a', proc: 'renderer' },
			{ v: 1, type: 'crash', ts: 'b', proc: 'renderer' },
		];
		const clusters = clusterCrashes(lines);
		assert.strictEqual(clusters.length, 1);
		assert.strictEqual(clusters[0].reason, undefined);
		assert.ok(clusters[0].signature.includes('unknown'));
	});
});
