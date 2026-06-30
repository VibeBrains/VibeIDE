/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideAccept,
	decidePartialThroughBlock,
} from '../../common/completionAcceptPolicy.js';

suite('Completion accept policy (1023)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideAccept — partial', () => {
		test('single line accepts the whole thing', () => {
			const r = decideAccept('return foo;', 'partial');
			assert.deepStrictEqual(r, { accepted: 'return foo;', remainder: '' });
		});

		test('multi-line accepts first line, drops the \\n', () => {
			const r = decideAccept('first\nsecond\nthird', 'partial');
			assert.deepStrictEqual(r, { accepted: 'first', remainder: 'second\nthird' });
		});

		test('starts with newline → accepted is empty, remainder is rest', () => {
			const r = decideAccept('\nfoo', 'partial');
			assert.deepStrictEqual(r, { accepted: '', remainder: 'foo' });
		});
	});

	suite('decideAccept — full', () => {
		test('always returns whole thing as accepted', () => {
			const r = decideAccept('a\nb\nc', 'full');
			assert.deepStrictEqual(r, { accepted: 'a\nb\nc', remainder: '' });
		});

		test('single line full = whole thing', () => {
			const r = decideAccept('xyz', 'full');
			assert.deepStrictEqual(r, { accepted: 'xyz', remainder: '' });
		});
	});

	suite('decideAccept — edge', () => {
		test('empty string returns empty accepted/remainder regardless of mode', () => {
			assert.deepStrictEqual(decideAccept('', 'partial'), { accepted: '', remainder: '' });
			assert.deepStrictEqual(decideAccept('', 'full'), { accepted: '', remainder: '' });
		});

		test('non-string input is treated as empty', () => {
			assert.deepStrictEqual(decideAccept(undefined as unknown as string, 'partial'), { accepted: '', remainder: '' });
		});
	});

	suite('decidePartialThroughBlock', () => {
		test('no brace → falls back to single-line accept', () => {
			const r = decidePartialThroughBlock('return foo\nelse bar');
			assert.deepStrictEqual(r, { accepted: 'return foo', remainder: 'else bar' });
		});

		test('balanced single block accepts up to and including closing brace', () => {
			const r = decidePartialThroughBlock('function f() {\n  return 1;\n}\nfunction g() {}');
			assert.strictEqual(r.accepted, 'function f() {\n  return 1;\n}');
			assert.strictEqual(r.remainder, '\nfunction g() {}');
		});

		test('nested braces tracked correctly', () => {
			const r = decidePartialThroughBlock('function outer() {\n  if (x) { return 1; }\n  return 2;\n}\nrest');
			assert.strictEqual(r.accepted, 'function outer() {\n  if (x) { return 1; }\n  return 2;\n}');
			assert.strictEqual(r.remainder, '\nrest');
		});

		test('unbalanced braces fall back to single-line accept', () => {
			const r = decidePartialThroughBlock('function broken() {\n  return\nrest');
			// Falls back to first line.
			assert.strictEqual(r.accepted, 'function broken() {');
		});

		test('empty input returns empty', () => {
			assert.deepStrictEqual(decidePartialThroughBlock(''), { accepted: '', remainder: '' });
		});
	});
});
