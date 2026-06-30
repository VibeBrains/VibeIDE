/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { detectLoopInHistory, AgentAction } from '../../browser/vibeLoopDetectorService.js';
import {
	dmsTimeoutMs,
	dmsEnabled,
	DMS_DEFAULT_TIMEOUT_MINUTES,
	DMS_MIN_TIMEOUT_MINUTES,
} from '../../browser/vibeDeadMansSwitchService.js';
import {
	computeBudgetStatus,
	accumulateUsage,
} from '../../common/vibeTokenBudgetService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Guard layer — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('detectLoopInHistory (LoopDetectorService)', () => {
		const a = (type: string, target: string): AgentAction => ({ type, target });

		test('history shorter than threshold → no loop', () => {
			assert.strictEqual(
				detectLoopInHistory([a('write', 'foo')], 3),
				false,
			);
		});

		test('three identical (type, target) actions → loop', () => {
			const h = [
				a('write', 'foo.ts'),
				a('write', 'foo.ts'),
				a('write', 'foo.ts'),
			];
			assert.strictEqual(detectLoopInHistory(h, 3), true);
		});

		test('three identical type but different targets → no loop', () => {
			const h = [
				a('write', 'foo.ts'),
				a('write', 'bar.ts'),
				a('write', 'baz.ts'),
			];
			assert.strictEqual(detectLoopInHistory(h, 3), false);
		});

		test('A → B → A pattern → loop', () => {
			const h = [
				a('write', 'foo.ts'),
				a('read', 'bar.ts'),
				a('write', 'foo.ts'),
			];
			assert.strictEqual(detectLoopInHistory(h, 3), true);
		});

		test('A → A → B does NOT count as A→B→A', () => {
			const h = [
				a('write', 'foo.ts'),
				a('write', 'foo.ts'),
				a('read', 'bar.ts'),
			];
			assert.strictEqual(detectLoopInHistory(h, 3), false);
		});

		test('threshold 5 needs five consecutive identical actions', () => {
			const four = [a('x', 't'), a('x', 't'), a('x', 't'), a('x', 't')];
			assert.strictEqual(detectLoopInHistory(four, 5), false);
			const five = [...four, a('x', 't')];
			assert.strictEqual(detectLoopInHistory(five, 5), true);
		});
	});

	suite('dmsTimeoutMs / dmsEnabled (DeadMansSwitchService)', () => {
		test('default constants are 5 minutes / 1 minute', () => {
			assert.strictEqual(DMS_DEFAULT_TIMEOUT_MINUTES, 5);
			assert.strictEqual(DMS_MIN_TIMEOUT_MINUTES, 1);
		});

		test('dmsTimeoutMs(0) → 0 (disable)', () => {
			assert.strictEqual(dmsTimeoutMs(0), 0);
		});

		test('dmsTimeoutMs clamps below minimum to 1 minute', () => {
			assert.strictEqual(dmsTimeoutMs(0.5), DMS_MIN_TIMEOUT_MINUTES * 60 * 1000);
			assert.strictEqual(dmsTimeoutMs(-3), DMS_MIN_TIMEOUT_MINUTES * 60 * 1000);
		});

		test('dmsTimeoutMs default 5 → 300_000 ms', () => {
			assert.strictEqual(dmsTimeoutMs(5), 5 * 60 * 1000);
			assert.strictEqual(dmsTimeoutMs(DMS_DEFAULT_TIMEOUT_MINUTES), 5 * 60 * 1000);
		});

		test('dmsEnabled returns false only at exactly 0', () => {
			assert.strictEqual(dmsEnabled(0), false);
			assert.strictEqual(dmsEnabled(1), true);
			assert.strictEqual(dmsEnabled(5), true);
		});

		test('dmsEnabled accepts null/undefined as enabled (use default)', () => {
			assert.strictEqual(dmsEnabled(null), true);
			assert.strictEqual(dmsEnabled(undefined), true);
		});
	});

	suite('computeBudgetStatus / accumulateUsage (TokenBudgetService)', () => {
		test('used 0 / limit 100 / enabled → 0 % not warn not exceeded', () => {
			const s = computeBudgetStatus(0, 100, true);
			assert.strictEqual(s.percentUsed, 0);
			assert.strictEqual(s.isWarning, false);
			assert.strictEqual(s.isExceeded, false);
		});

		test('used >= limit → exceeded', () => {
			const s = computeBudgetStatus(100, 100, true);
			assert.strictEqual(s.isExceeded, true);
		});

		test('used in [80,100) → warning, not exceeded', () => {
			const s = computeBudgetStatus(80, 100, true);
			assert.strictEqual(s.isWarning, true);
			assert.strictEqual(s.isExceeded, false);
		});

		test('disabled never reports exceeded or warning', () => {
			const s = computeBudgetStatus(1000, 100, false);
			assert.strictEqual(s.isWarning, false);
			assert.strictEqual(s.isExceeded, false);
		});

		test('limit 0 → percent 0 (avoid divide by zero)', () => {
			const s = computeBudgetStatus(50, 0, true);
			assert.strictEqual(s.percentUsed, 0);
		});

		test('accumulateUsage adds clamped values', () => {
			assert.strictEqual(accumulateUsage(10, 5, 3), 18);
			assert.strictEqual(accumulateUsage(10, -100, 3), 13, 'negative input clamped to 0');
			assert.strictEqual(accumulateUsage(10, 5, -100), 15, 'negative output clamped to 0');
			assert.strictEqual(accumulateUsage(0, 0, 0), 0);
		});
	});
});
