/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	appendPromptToHistory,
	navigateHistory,
	QUICK_EDIT_HISTORY_DEFAULT_MAX,
} from '../../common/quickEditPromptHistory.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('quickEditPromptHistory', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('appendPromptToHistory', () => {

		test('appends to end', () => {
			assert.deepStrictEqual(
				appendPromptToHistory(['a', 'b'], 'c'),
				['a', 'b', 'c'],
			);
		});

		test('empty / whitespace prompt is rejected', () => {
			assert.deepStrictEqual(appendPromptToHistory(['a'], ''), ['a']);
			assert.deepStrictEqual(appendPromptToHistory(['a'], '   '), ['a']);
			assert.deepStrictEqual(appendPromptToHistory(['a'], '\n\t'), ['a']);
		});

		test('duplicate of most-recent is no-op', () => {
			assert.deepStrictEqual(
				appendPromptToHistory(['a', 'b'], 'b'),
				['a', 'b'],
			);
		});

		test('duplicate older entry is moved to head', () => {
			assert.deepStrictEqual(
				appendPromptToHistory(['a', 'b', 'c'], 'a'),
				['b', 'c', 'a'],
			);
		});

		test('max size enforced — oldest dropped', () => {
			assert.deepStrictEqual(
				appendPromptToHistory(['a', 'b', 'c'], 'd', 3),
				['b', 'c', 'd'],
			);
		});

		test('max size 0/negative coerced to 1', () => {
			assert.deepStrictEqual(appendPromptToHistory(['a'], 'b', 0), ['b']);
			assert.deepStrictEqual(appendPromptToHistory(['a'], 'b', -5), ['b']);
		});

		test('default max size is 50', () => {
			assert.strictEqual(QUICK_EDIT_HISTORY_DEFAULT_MAX, 50);
			const filled = Array.from({ length: 50 }, (_, i) => `p${i}`);
			const result = appendPromptToHistory(filled, 'new');
			assert.strictEqual(result.length, 50);
			assert.strictEqual(result[result.length - 1], 'new');
			assert.strictEqual(result[0], 'p1', 'oldest p0 should be dropped');
		});

		test('trims whitespace before storage', () => {
			assert.deepStrictEqual(
				appendPromptToHistory(['a'], '   hello   '),
				['a', 'hello'],
			);
		});

		test('non-string input is rejected', () => {
			// @ts-expect-error — intentional type bypass for runtime defense
			assert.deepStrictEqual(appendPromptToHistory(['a'], 123), ['a']);
		});

		test('does not mutate input array', () => {
			const original = ['a', 'b'];
			appendPromptToHistory(original, 'c');
			assert.deepStrictEqual(original, ['a', 'b']);
		});
	});

	suite('navigateHistory', () => {

		const hist = ['old', 'middle', 'newest'];

		test('up from present → newest entry', () => {
			const out = navigateHistory(hist, hist.length, -1);
			assert.strictEqual(out.value, 'newest');
			assert.strictEqual(out.newIndex, 2);
		});

		test('up from middle → older', () => {
			const out = navigateHistory(hist, 2, -1);
			assert.strictEqual(out.value, 'middle');
			assert.strictEqual(out.newIndex, 1);
		});

		test('up at oldest → no further', () => {
			const out = navigateHistory(hist, 0, -1);
			assert.strictEqual(out.value, null);
			assert.strictEqual(out.newIndex, 0);
		});

		test('down from older → newer', () => {
			const out = navigateHistory(hist, 0, 1);
			assert.strictEqual(out.value, 'middle');
			assert.strictEqual(out.newIndex, 1);
		});

		test('down from newest → return-to-present', () => {
			const out = navigateHistory(hist, 2, 1);
			assert.strictEqual(out.value, '');
			assert.strictEqual(out.newIndex, 3);
		});

		test('down past present → no further', () => {
			const out = navigateHistory(hist, hist.length, 1);
			assert.strictEqual(out.value, null);
			assert.strictEqual(out.newIndex, hist.length);
		});

		test('empty history → null in any direction', () => {
			assert.strictEqual(navigateHistory([], 0, -1).value, null);
			assert.strictEqual(navigateHistory([], 0, 1).value, null);
		});

		test('out-of-bounds currentIndex is clamped', () => {
			const out = navigateHistory(hist, 100, -1);
			assert.strictEqual(out.value, 'newest');
		});
	});
});
