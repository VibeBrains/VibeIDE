/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyLinkedReferencesBudget } from '../../common/linkedReferencesBudget.js';

suite('linkedReferencesBudget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('все файлы влезают — встраиваем целиком и в исходном порядке', () => {
		assert.deepStrictEqual(
			applyLinkedReferencesBudget([
				{ path: 'docs/a.md', content: '12345' },
				{ path: 'docs/b.md', content: '123' },
			], 8),
			{
				inlined: [
					{ path: 'docs/a.md', content: '12345' },
					{ path: 'docs/b.md', content: '123' },
				],
				notInlined: [],
			},
		);
	});

	test('крупный файл не режем посередине, а меньший следующий ещё влезает', () => {
		assert.deepStrictEqual(
			applyLinkedReferencesBudget([
				{ path: 'docs/a.md', content: '12345' },
				{ path: 'docs/big.md', content: '1234567890' },
				{ path: 'docs/small.md', content: '12' },
			], 7),
			{
				inlined: [
					{ path: 'docs/a.md', content: '12345' },
					{ path: 'docs/small.md', content: '12' },
				],
				notInlined: [{ path: 'docs/big.md', chars: 10 }],
			},
		);
	});

	test('бюджет 0 — не встраиваем ничего, все файлы остаются путями', () => {
		assert.deepStrictEqual(
			applyLinkedReferencesBudget([{ path: 'docs/a.md', content: '12345' }], 0),
			{ inlined: [], notInlined: [{ path: 'docs/a.md', chars: 5 }] },
		);
	});

	test('пустой вход — пустой результат', () => {
		assert.deepStrictEqual(
			applyLinkedReferencesBudget([], 20000),
			{ inlined: [], notInlined: [] },
		);
	});
});
