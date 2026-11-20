/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applySkillsIndexBudget } from '../../common/skillsIndexBudget.js';

suite('skillsIndexBudget', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('все строки влезают — отдаём их целиком в исходном порядке', () => {
		assert.deepStrictEqual(
			applySkillsIndexBudget([
				{ name: 'alpha', line: '- /skill:alpha — A: one' },
				{ name: 'beta', line: '- /skill:beta — B: two' },
			], 100),
			{
				lines: ['- /skill:alpha — A: one', '- /skill:beta — B: two'],
				namesOnly: [],
			},
		);
	});

	test('длинная строка не влезает, следующая короткая ещё помещается', () => {
		assert.deepStrictEqual(
			applySkillsIndexBudget([
				{ name: 'alpha', line: '12345' },
				{ name: 'beta', line: '1234567890' },
				{ name: 'gamma', line: '12' },
			], 7),
			{ lines: ['12345', '12'], namesOnly: ['beta'] },
		);
	});

	test('бюджет 0 — все навыки остаются только именами', () => {
		assert.deepStrictEqual(
			applySkillsIndexBudget([{ name: 'alpha', line: '- /skill:alpha — A: one' }], 0),
			{ lines: [], namesOnly: ['alpha'] },
		);
	});

	test('пустой вход — пустой результат', () => {
		assert.deepStrictEqual(
			applySkillsIndexBudget([], 12000),
			{ lines: [], namesOnly: [] },
		);
	});
});
