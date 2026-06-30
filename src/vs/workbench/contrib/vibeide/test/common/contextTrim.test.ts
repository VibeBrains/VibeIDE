/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { pickHeaviestTrimmableIndex } from '../../common/prompt/contextTrim.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('pickHeaviestTrimmableIndex — context-trim victim selection (D.16)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('all weight 0 (everything pinned) → -1 (nothing trimmable)', () => {
		assert.strictEqual(pickHeaviestTrimmableIndex([0, 0, 0]), -1);
	});

	test('empty input → -1', () => {
		assert.strictEqual(pickHeaviestTrimmableIndex([]), -1);
	});

	test('picks the index of the largest positive weight', () => {
		assert.strictEqual(pickHeaviestTrimmableIndex([0, 5, 3]), 1);
	});

	test('D.16 regression: a zero-weight message at index 0 (pinned system) is NEVER selected', () => {
		// Old -Infinity-seeded scan returned 0 here and chopped the system to TRIM_TO_LEN.
		assert.strictEqual(pickHeaviestTrimmableIndex([0, 2]), 1);
	});

	test('system pinned (0) + huge pinned tool result (0) → -1, even though both are over budget', () => {
		assert.strictEqual(pickHeaviestTrimmableIndex([0, 0]), -1);
	});

	test('returns the FIRST index on ties', () => {
		assert.strictEqual(pickHeaviestTrimmableIndex([4, 4, 1]), 0);
	});

	test('mixed pinned/trimmable picks the heaviest trimmable', () => {
		assert.strictEqual(pickHeaviestTrimmableIndex([0, 10, 0, 7, 0]), 1);
	});
});
