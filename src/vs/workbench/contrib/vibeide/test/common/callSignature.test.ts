/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { activeCallAt, splitParameters } from '../../common/codeSymbols/callSignature.js';

/**
 * Reading a call while it is still being typed.
 *
 * The code at that moment is incomplete — the closing bracket does not exist yet — so this is done
 * by scanning text backwards rather than by parsing, and the tests fix the cases where naive
 * scanning would lie: commas inside strings, nested calls, and brackets that are not calls at all.
 */
suite('call signature', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const at = (line: string) => activeCallAt(line, line.indexOf('|') >= 0 ? line.indexOf('|') : line.length);
	const clean = (line: string) => line.replace('|', '');

	test('the call under the cursor and the argument index', () => {
		const cases: [string, unknown][] = [
			// `$this` names the owner implicitly — the caller resolves it to the enclosing class.
			['$this->pay(|', { name: 'pay', argumentIndex: 0, throughThis: true }],
			['$this->pay(1, |', { name: 'pay', argumentIndex: 1, throughThis: true }],
			['$this->pay(1, 2, |', { name: 'pay', argumentIndex: 2, throughThis: true }],
			// A nested call owns its own commas: the cursor is in `inner`, on its first argument.
			['pay(1, inner(|', { name: 'inner', argumentIndex: 0 }],
			// …and after the nested call closes, we are back in the outer one — third argument, since
			// two top-level commas have been passed.
			['pay(1, inner(2, 3), |', { name: 'pay', argumentIndex: 2 }],
			// A comma inside a string is text, not a separator.
			['pay("a, b", |', { name: 'pay', argumentIndex: 1 }],
			// A named type is worth keeping: it says whose signature to show first.
			['Invoice::make(|', { name: 'make', argumentIndex: 0, owner: 'Invoice' }],
			['App\\Billing\\Invoice::make(|', { name: 'make', argumentIndex: 0, owner: 'Invoice' }],
			// A lower-case owner is a variable, and its type is unknowable here.
			['$repo->save(|', { name: 'save', argumentIndex: 0 }],
		];
		assert.deepStrictEqual(
			cases.map(([line]) => at(clean(line))),
			cases.map(([, expected]) => expected),
		);
	});

	test('brackets that are not a call yield nothing', () => {
		assert.strictEqual(at('$items = [1, 2, '), undefined, 'массив — не вызов');
		assert.strictEqual(at('$x = 1 + '), undefined);
		assert.strictEqual(at('function pay('), undefined, 'объявление: перед скобкой ключевое слово, а не вызов');
		assert.strictEqual(at(''), undefined);
	});

	/** A default value may itself contain commas and brackets — splitting on «,» would break it. */
	test('parameters split on their own commas only', () => {
		assert.deepStrictEqual(splitParameters('(int $x, string $y = "a, b")'), ['int $x', 'string $y = "a, b"']);
		assert.deepStrictEqual(splitParameters('(array $rules = ["a", "b"], int $x)'), ['array $rules = ["a", "b"]', 'int $x']);
		assert.deepStrictEqual(splitParameters('()'), []);
		assert.deepStrictEqual(splitParameters('(x int, y string)'), ['x int', 'y string']);
	});
});
