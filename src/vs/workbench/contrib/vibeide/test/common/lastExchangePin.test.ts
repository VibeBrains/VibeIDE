/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { computeLastExchangePinSet, PinnableMessage } from '../../common/prompt/lastExchangePin.js';

const m = (role: string, content: string): PinnableMessage => ({ role, content });
const idxs = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b);

suite('computeLastExchangePinSet — pin last assistant↔tool exchange (3074)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no tool message → empty set', () => {
		const msgs = [m('system', 'sys'), m('user', 'hi'), m('assistant', 'hello')];
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 100000)), []);
	});

	test('pins the last tool-result and its preceding assistant', () => {
		const msgs = [m('system', 's'), m('user', 'read x'), m('assistant', 'reading'), m('tool', 'FILE BODY')];
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 100000)), [2, 3]);
	});

	test('only the LAST exchange is pinned when several tool results exist', () => {
		const msgs = [
			m('user', 'a'), m('assistant', 'a1'), m('tool', 'r1'), // older exchange
			m('assistant', 'a2'), m('tool', 'r2'),                 // latest exchange
		];
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 100000)), [3, 4]);
	});

	test('nearest preceding assistant is chosen (skips intervening user)', () => {
		const msgs = [m('assistant', 'a'), m('user', 'u'), m('tool', 'r')];
		// assistant at 0 is the nearest preceding assistant before the tool at 2
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 100000)), [0, 2]);
	});

	test('tool with no preceding assistant → pins only the tool', () => {
		const msgs = [m('user', 'u'), m('tool', 'r')];
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 100000)), [1]);
	});

	test('safety valve: pair larger than budget → empty set (stays trimmable)', () => {
		const msgs = [m('assistant', 'x'.repeat(40)), m('tool', 'y'.repeat(80))]; // pair = 120 chars
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 100)), []);
	});

	test('safety valve disabled when budgetChars <= 0 (unknown budget → pin anyway)', () => {
		const msgs = [m('assistant', 'x'.repeat(40)), m('tool', 'y'.repeat(80))];
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 0)), [0, 1]);
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, -5)), [0, 1]);
	});

	test('pair exactly at budget is still pinned (boundary: only > budget skips)', () => {
		const msgs = [m('assistant', 'aa'), m('tool', 'bbb')]; // pair = 5
		assert.deepStrictEqual(idxs(computeLastExchangePinSet(msgs, 5)), [0, 1]);
	});
});
