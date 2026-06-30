/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { lenientJsonParse, lenientJsonParseObject } from '../../common/lenientJson.js';

suite('lenientJson', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	suite('lenientJsonParse — valid passes through untouched', () => {
		test('valid object', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":1,"b":"x"}'), { a: 1, b: 'x' });
		});
		test('string value containing ,} and quotes is NOT corrupted (strict parse wins)', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":"x,}"}'), { a: 'x,}' });
			assert.deepStrictEqual(lenientJsonParse('{"command":"echo \\"hi\\""}'), { command: 'echo "hi"' });
		});
	});

	suite('lenientJsonParse — repairs', () => {
		test('trailing comma in object', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":1,}'), { a: 1 });
		});
		test('trailing comma in array', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":[1,2,]}'), { a: [1, 2] });
		});
		test('nested trailing commas', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":{"b":1,},}'), { a: { b: 1 } });
		});
		test('trailing prose after the value', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":1} here you go!'), { a: 1 });
		});
		test('leading prose before the value', () => {
			assert.deepStrictEqual(lenientJsonParse('Sure: {"a":1}'), { a: 1 });
		});
		test('truncated unterminated string', () => {
			assert.deepStrictEqual(lenientJsonParse('{"path":"d:/x.ts'), { path: 'd:/x.ts' });
		});
		test('truncated unclosed object/array', () => {
			assert.deepStrictEqual(lenientJsonParse('{"a":1'), { a: 1 });
			assert.deepStrictEqual(lenientJsonParse('{"a":[1,2'), { a: [1, 2] });
		});
		test('truncated string preserves escaped quote', () => {
			assert.deepStrictEqual(lenientJsonParse('{"command":"echo \\"hi\\"'), { command: 'echo "hi"' });
		});
	});

	suite('lenientJsonParse — gives up safely (returns undefined)', () => {
		test('single-quoted keys/values are NOT guessed', () => {
			assert.strictEqual(lenientJsonParse("{'a':1}"), undefined);
		});
		test('dangling value is not fabricated', () => {
			assert.strictEqual(lenientJsonParse('{"a":1,"b":'), undefined);
		});
		test('non-string input', () => {
			assert.strictEqual(lenientJsonParse(42 as unknown), undefined);
			assert.strictEqual(lenientJsonParse(null as unknown), undefined);
		});
		test('empty / no structural value', () => {
			assert.strictEqual(lenientJsonParse(''), undefined);
			assert.strictEqual(lenientJsonParse('just prose, no json'), undefined);
		});
	});

	suite('lenientJsonParseObject — object-only', () => {
		test('returns object for repaired object', () => {
			assert.deepStrictEqual(lenientJsonParseObject('{"a":1,}'), { a: 1 });
		});
		test('returns undefined for a top-level array', () => {
			assert.strictEqual(lenientJsonParseObject('[1,2,]'), undefined);
			// but lenientJsonParse still recovers the array itself
			assert.deepStrictEqual(lenientJsonParse('[1,2,]'), [1, 2]);
		});
		test('returns undefined for unrecoverable input', () => {
			assert.strictEqual(lenientJsonParseObject("{'a':1}"), undefined);
		});
	});
});
