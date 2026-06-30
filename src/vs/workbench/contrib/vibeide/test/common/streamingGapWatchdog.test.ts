/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	transitionWatchdog,
	WATCHDOG_DEFAULTS,
	WatchdogState,
	WatchdogConfig,
} from '../../common/streamingGapWatchdog.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_000_000;

const cfg = (overrides: Partial<WatchdogConfig> = {}): WatchdogConfig => ({ ...WATCHDOG_DEFAULTS, ...overrides });

suite('Streaming gap watchdog FSM (K.4 / 958, 959, 960)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('start from idle moves to streaming + show-typing', () => {
		const t = transitionWatchdog({ kind: 'idle' }, { kind: 'start', now: NOW });
		assert.strictEqual(t.state.kind, 'streaming');
		assert.deepStrictEqual(t.effects, [{ kind: 'show-typing' }]);
	});

	test('chunk in streaming bumps lastChunkAt and chunkCount, no effects', () => {
		const s: WatchdogState = { kind: 'streaming', lastChunkAt: NOW, chunkCount: 3 };
		const t = transitionWatchdog(s, { kind: 'chunk', now: NOW + 100 });
		assert.deepStrictEqual(t.state, { kind: 'streaming', lastChunkAt: NOW + 100, chunkCount: 4 });
		assert.deepStrictEqual(t.effects, []);
	});

	test('tick before timeout in streaming → no transition', () => {
		const s: WatchdogState = { kind: 'streaming', lastChunkAt: NOW, chunkCount: 0 };
		const t = transitionWatchdog(s, { kind: 'tick', now: NOW + 1000 }, cfg({ gapTimeoutMs: 30_000 }));
		assert.deepStrictEqual(t.state, s);
		assert.deepStrictEqual(t.effects, []);
	});

	test('tick past gapTimeout from streaming → waiting + show-waiting', () => {
		const s: WatchdogState = { kind: 'streaming', lastChunkAt: NOW, chunkCount: 0 };
		const t = transitionWatchdog(s, { kind: 'tick', now: NOW + 31_000 }, cfg({ gapTimeoutMs: 30_000 }));
		assert.strictEqual(t.state.kind, 'waiting');
		assert.deepStrictEqual(t.effects, [{ kind: 'show-waiting' }]);
	});

	test('chunk in waiting moves to streaming + show-typing + audit gap_recovered', () => {
		const s: WatchdogState = { kind: 'waiting', lastChunkAt: NOW, chunkCount: 5, waitingSince: NOW + 31_000 };
		const t = transitionWatchdog(s, { kind: 'chunk', now: NOW + 32_000 });
		assert.strictEqual(t.state.kind, 'streaming');
		assert.deepStrictEqual(t.effects[0], { kind: 'show-typing' });
		assert.deepStrictEqual(t.effects[1], { kind: 'audit', event: 'stream_gap_recovered' });
	});

	test('tick in waiting after retry1AfterMs → retrying attempt 1', () => {
		const s: WatchdogState = { kind: 'waiting', lastChunkAt: NOW, chunkCount: 0, waitingSince: NOW + 30_000 };
		const t = transitionWatchdog(s, { kind: 'tick', now: NOW + 35_000 }, cfg({ retry1AfterMs: 5_000 }));
		assert.strictEqual(t.state.kind, 'retrying');
		if (t.state.kind === 'retrying') { assert.strictEqual(t.state.attempt, 1); }
	});

	test('tick in retrying attempt-1 after retry2AfterMs → retrying attempt 2', () => {
		const c = cfg({ retry1AfterMs: 5_000, retry2AfterMs: 15_000 });
		const s: WatchdogState = { kind: 'retrying', attempt: 1, nextRetryAt: NOW + 5_000 };
		const t = transitionWatchdog(s, { kind: 'tick', now: NOW + 6_000 }, c);
		assert.strictEqual(t.state.kind, 'retrying');
		if (t.state.kind === 'retrying') { assert.strictEqual(t.state.attempt, 2); }
	});

	test('tick in retrying attempt-2 past nextRetryAt → failed gap-timeout', () => {
		const s: WatchdogState = { kind: 'retrying', attempt: 2, nextRetryAt: NOW + 5_000 };
		const t = transitionWatchdog(s, { kind: 'tick', now: NOW + 5_001 });
		assert.strictEqual(t.state.kind, 'failed');
		if (t.state.kind === 'failed') { assert.strictEqual(t.state.reason, 'gap-timeout'); }
		assert.deepStrictEqual(t.effects, [{ kind: 'audit', event: 'stream_failed' }]);
	});

	test('cancel from streaming → failed cancelled + audit', () => {
		const s: WatchdogState = { kind: 'streaming', lastChunkAt: NOW, chunkCount: 1 };
		const t = transitionWatchdog(s, { kind: 'cancel', now: NOW + 100 });
		assert.strictEqual(t.state.kind, 'failed');
		if (t.state.kind === 'failed') { assert.strictEqual(t.state.reason, 'cancelled'); }
		assert.deepStrictEqual(t.effects, [{ kind: 'audit', event: 'stream_cancelled' }]);
	});

	test('cancel from failed is a no-op', () => {
		const s: WatchdogState = { kind: 'failed', reason: 'cancelled', finalAt: NOW };
		const t = transitionWatchdog(s, { kind: 'cancel', now: NOW + 1 });
		assert.deepStrictEqual(t.state, s);
		assert.deepStrictEqual(t.effects, [{ kind: 'no-op' }]);
	});

	test('complete moves to completed + audit completed', () => {
		const s: WatchdogState = { kind: 'streaming', lastChunkAt: NOW, chunkCount: 1 };
		const t = transitionWatchdog(s, { kind: 'complete', now: NOW + 1000 });
		assert.strictEqual(t.state.kind, 'completed');
		assert.deepStrictEqual(t.effects, [{ kind: 'audit', event: 'stream_completed' }]);
	});

	test('provider-error from streaming → failed provider-error', () => {
		const s: WatchdogState = { kind: 'streaming', lastChunkAt: NOW, chunkCount: 1 };
		const t = transitionWatchdog(s, { kind: 'provider-error', now: NOW + 1000 });
		assert.strictEqual(t.state.kind, 'failed');
		if (t.state.kind === 'failed') { assert.strictEqual(t.state.reason, 'provider-error'); }
	});

	test('retry-now from waiting → retrying attempt 1', () => {
		const s: WatchdogState = { kind: 'waiting', lastChunkAt: NOW, chunkCount: 0, waitingSince: NOW + 30_000 };
		const t = transitionWatchdog(s, { kind: 'retry-now', now: NOW + 31_000 });
		assert.strictEqual(t.state.kind, 'retrying');
		if (t.state.kind === 'retrying') { assert.strictEqual(t.state.attempt, 1); }
	});

	test('retry-now from retrying attempt-1 escalates to attempt 2', () => {
		const s: WatchdogState = { kind: 'retrying', attempt: 1, nextRetryAt: NOW + 5_000 };
		const t = transitionWatchdog(s, { kind: 'retry-now', now: NOW + 1000 });
		assert.strictEqual(t.state.kind, 'retrying');
		if (t.state.kind === 'retrying') { assert.strictEqual(t.state.attempt, 2); }
	});

	test('maxAutoRetries=0 keeps waiting on tick', () => {
		const s: WatchdogState = { kind: 'waiting', lastChunkAt: NOW, chunkCount: 0, waitingSince: NOW + 30_000 };
		const t = transitionWatchdog(s, { kind: 'tick', now: NOW + 100_000 }, cfg({ maxAutoRetries: 0 }));
		assert.deepStrictEqual(t.state, s);
		assert.deepStrictEqual(t.effects, []);
	});

	test('chunk in idle is a no-op', () => {
		const t = transitionWatchdog({ kind: 'idle' }, { kind: 'chunk', now: NOW });
		assert.deepStrictEqual(t.state, { kind: 'idle' });
		assert.deepStrictEqual(t.effects, [{ kind: 'no-op' }]);
	});
});
