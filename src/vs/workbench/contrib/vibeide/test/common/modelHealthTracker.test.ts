/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	ModelHealthTracker,
	HEALTH_WINDOW_MS,
	HEALTH_FAILURE_THRESHOLD,
	SUPPRESSION_WINDOW_MS,
} from '../../common/modelHealthTracker.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const T0 = 1_700_000_000_000;  // arbitrary epoch base

suite('ModelHealthTracker — basic counting', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty tracker → no notification', () => {
		const t = new ModelHealthTracker();
		assert.strictEqual(t.shouldNotify('p', 'm'), false);
		assert.strictEqual(t.getFailureCount('p', 'm'), 0);
	});

	test('below threshold → no notification', () => {
		const t = new ModelHealthTracker();
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD - 1; i++) {
			t.recordFailure('p', 'm', 'empty-response', T0 + i * 1000);
		}
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 10_000), false);
	});

	test('at threshold → notification fires once', () => {
		const t = new ModelHealthTracker();
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD; i++) {
			t.recordFailure('p', 'm', 'empty-response', T0 + i * 1000);
		}
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 10_000), true);
		// Second call within suppression window → silent.
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 11_000), false);
	});
});

suite('ModelHealthTracker — rolling window', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('failures outside window are pruned', () => {
		const t = new ModelHealthTracker();
		// 3 failures well in the past (before the window).
		const past = T0 - HEALTH_WINDOW_MS - 60_000;
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD; i++) {
			t.recordFailure('p', 'm', 'empty-response', past + i * 1000);
		}
		// Now check at T0 — past failures pruned.
		assert.strictEqual(t.getFailureCount('p', 'm', T0), 0);
		assert.strictEqual(t.shouldNotify('p', 'm', T0), false);
	});

	test('mixed in-window and out-of-window — only in-window counted', () => {
		const t = new ModelHealthTracker();
		const past = T0 - HEALTH_WINDOW_MS - 60_000;
		t.recordFailure('p', 'm', 'empty-response', past);
		t.recordFailure('p', 'm', 'empty-response', past + 1000);
		t.recordFailure('p', 'm', 'empty-response', T0 - 1000);  // in-window
		t.recordFailure('p', 'm', 'empty-response', T0);         // in-window
		assert.strictEqual(t.getFailureCount('p', 'm', T0 + 100), 2);
	});
});

suite('ModelHealthTracker — suppression after notification', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('within suppression window → silent', () => {
		const t = new ModelHealthTracker();
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD; i++) {
			t.recordFailure('p', 'm', 'empty-response', T0 + i * 1000);
		}
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 10_000), true);
		// Another failure inside suppression window
		t.recordFailure('p', 'm', 'empty-response', T0 + 60_000);
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 70_000), false);
	});

	test('after suppression window expires → can notify again', () => {
		const t = new ModelHealthTracker();
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD; i++) {
			t.recordFailure('p', 'm', 'empty-response', T0 + i * 1000);
		}
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 10_000), true);
		// Add more failures and wait past suppression window.
		t.recordFailure('p', 'm', 'empty-response', T0 + 10_000);
		t.recordFailure('p', 'm', 'empty-response', T0 + 20_000);
		t.recordFailure('p', 'm', 'empty-response', T0 + 30_000);
		const afterSuppression = T0 + 10_000 + SUPPRESSION_WINDOW_MS + 1000;
		assert.strictEqual(t.shouldNotify('p', 'm', afterSuppression), true);
	});
});

suite('ModelHealthTracker — recordSuccess resets', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('success after threshold → counter cleared, no notification', () => {
		const t = new ModelHealthTracker();
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD; i++) {
			t.recordFailure('p', 'm', 'empty-response', T0 + i * 1000);
		}
		t.recordSuccess('p', 'm');
		assert.strictEqual(t.getFailureCount('p', 'm', T0 + 10_000), 0);
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 10_000), false);
	});

	test('success then more failures → new cycle from zero', () => {
		const t = new ModelHealthTracker();
		t.recordFailure('p', 'm', 'empty-response', T0);
		t.recordFailure('p', 'm', 'empty-response', T0 + 1000);
		t.recordSuccess('p', 'm');
		// Recovery, then failures resume.
		t.recordFailure('p', 'm', 'empty-response', T0 + 2000);
		assert.strictEqual(t.getFailureCount('p', 'm', T0 + 3000), 1);  // not 3 — counter reset
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 3000), false);
	});
});

suite('ModelHealthTracker — isolation between combos', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('different (provider, model) tuples are tracked independently', () => {
		const t = new ModelHealthTracker();
		for (let i = 0; i < HEALTH_FAILURE_THRESHOLD; i++) {
			t.recordFailure('openCodeGo', 'minimax-m2.7', 'empty-response', T0 + i * 1000);
		}
		// Same model name, different provider → separate counter.
		assert.strictEqual(t.getFailureCount('directProvider', 'minimax-m2.7', T0 + 10_000), 0);
		// Same provider, different model → separate counter.
		assert.strictEqual(t.getFailureCount('openCodeGo', 'kimi-k2.6', T0 + 10_000), 0);
		// Original combo still flagged.
		assert.strictEqual(t.shouldNotify('openCodeGo', 'minimax-m2.7', T0 + 10_000), true);
	});
});

suite('ModelHealthTracker — failure kinds tracked together', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('mix of empty-response / context-overflow / invalid-params counts toward same threshold', () => {
		const t = new ModelHealthTracker();
		t.recordFailure('p', 'm', 'empty-response', T0);
		t.recordFailure('p', 'm', 'context-overflow', T0 + 1000);
		t.recordFailure('p', 'm', 'invalid-params', T0 + 2000);
		assert.strictEqual(t.getFailureCount('p', 'm', T0 + 3000), 3);
		assert.strictEqual(t.shouldNotify('p', 'm', T0 + 3000), true);
	});
});
