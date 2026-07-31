/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { decideVerifyGate } from '../../common/verifyGatePolicy.js';

const BASE = { verified: true, passed: false, attemptsUsed: 0, maxAttempts: 3 } as const;

suite('verifyGatePolicy — decideVerifyGate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('inert paths always complete: off mode, not-verified, or passed — regardless of failures', () => {
		assert.deepStrictEqual(
			[
				decideVerifyGate({ ...BASE, mode: 'off' }),                       // gate disabled
				decideVerifyGate({ ...BASE, mode: 'enforce', verified: false }),  // no command / no edits
				decideVerifyGate({ ...BASE, mode: 'enforce', passed: true }),     // verify green
				decideVerifyGate({ ...BASE, mode: 'warn', passed: true }),
			],
			['complete', 'complete', 'complete', 'complete'],
		);
	});

	test('warn: a red verify still completes (with a note)', () => {
		assert.strictEqual(decideVerifyGate({ ...BASE, mode: 'warn' }), 'warn-complete');
	});

	test('enforce: bounce until maxAttempts reached, then stop', () => {
		assert.deepStrictEqual(
			[
				decideVerifyGate({ ...BASE, mode: 'enforce', attemptsUsed: 0 }),
				decideVerifyGate({ ...BASE, mode: 'enforce', attemptsUsed: 2 }),
				decideVerifyGate({ ...BASE, mode: 'enforce', attemptsUsed: 3 }), // == maxAttempts → stop
				decideVerifyGate({ ...BASE, mode: 'enforce', attemptsUsed: 9 }),
			],
			['bounce', 'bounce', 'stop', 'stop'],
		);
	});

	test('enforce: maxAttempts is floored at 1 so a zero/garbage ceiling still stops instead of looping', () => {
		assert.strictEqual(decideVerifyGate({ ...BASE, mode: 'enforce', attemptsUsed: 0, maxAttempts: 0 }), 'bounce');
		assert.strictEqual(decideVerifyGate({ ...BASE, mode: 'enforce', attemptsUsed: 1, maxAttempts: 0 }), 'stop');
	});
});
