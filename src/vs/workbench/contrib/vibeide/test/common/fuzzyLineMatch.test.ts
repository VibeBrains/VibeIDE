/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { findLinesTolerant } from '../../common/helpers/fuzzyLineMatch.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const FILE = [
	'function greet(name) {',          // 1
	'    const msg = "hi " + name;',   // 2
	'    console.log(msg);',           // 3
	'    return msg;',                 // 4
	'}',                               // 5
	'',                                // 6
	'function bye(name) {',            // 7
	'    return "bye " + name;',       // 8
	'}',                               // 9
].join('\n');

suite('fuzzyLineMatch — tolerant line matching', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exact match → its line range (1-indexed inclusive)', () => {
		assert.deepStrictEqual(findLinesTolerant('    console.log(msg);', FILE), [3, 3]);
	});

	test('indentation drift is forgiven (line-trimmed)', () => {
		// model emitted the line with NO leading indent
		assert.deepStrictEqual(findLinesTolerant('console.log(msg);', FILE), [3, 3]);
	});

	test('trailing-whitespace drift is forgiven', () => {
		assert.deepStrictEqual(findLinesTolerant('    return msg;   ', FILE), [4, 4]);
	});

	test('multi-line block with wrong indentation matches', () => {
		const search = ['const msg = "hi " + name;', 'console.log(msg);', 'return msg;'].join('\n');
		assert.deepStrictEqual(findLinesTolerant(search, FILE), [2, 4]);
	});

	test('block-anchor: paraphrased MIDDLE line still matches via first/last anchors', () => {
		// first line + last line match verbatim; middle is slightly off
		const search = ['function greet(name) {', '    const msg = "hello " + name;', '    console.log(msg);', '    return msg;', '}'].join('\n');
		assert.deepStrictEqual(findLinesTolerant(search, FILE), [1, 5]);
	});

	test('trailing newline in search text does not shift the range', () => {
		assert.deepStrictEqual(findLinesTolerant('    console.log(msg);\n', FILE), [3, 3]);
	});

	test('genuinely absent text → not-found', () => {
		assert.strictEqual(findLinesTolerant('this line does not exist anywhere', FILE), 'not-found');
	});

	test('ambiguous repeated single line → not-unique', () => {
		const repeated = ['a();', 'b();', 'a();'].join('\n');
		assert.strictEqual(findLinesTolerant('a();', repeated), 'not-unique');
	});

	test('fromLine restricts the search window', () => {
		const dup = ['x();', 'mark();', 'x();'].join('\n');
		// without restriction → ambiguous; restricted to line 3+ → unique
		assert.strictEqual(findLinesTolerant('x();', dup), 'not-unique');
		assert.deepStrictEqual(findLinesTolerant('x();', dup, 3), [3, 3]);
	});

	test('span size is bounded — a tiny search never matches a huge unrelated block', () => {
		// 2-line search shouldn't get block-anchored across the whole file
		const r = findLinesTolerant(['function greet(name) {', '}'].join('\n'), FILE);
		// first line matches line 1, but the matching close brace is line 5 (its own function) only via
		// exact/line-trimmed of a 2-line block — which requires consecutive lines, so → not-found here.
		assert.strictEqual(r, 'not-found');
	});
});
