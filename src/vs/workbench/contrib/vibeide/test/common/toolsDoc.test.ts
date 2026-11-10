/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinToolDefs } from '../../common/prompt/tools/index.js';
import { toolsDocRows } from '../../common/prompt/tools/toolsDoc.js';

/** Ниже этого числа набор инструментов просел — обычно из-за удаления без замены */
const MIN_TOOLS = 49;

suite('toolsDoc — список инструментов совпадает с реестром', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('инструментов не меньше MIN_TOOLS', () => {
		assert.deepStrictEqual(Object.keys(builtinToolDefs).length >= MIN_TOOLS, true);
	});

	test('имена уникальны', () => {
		const names = Object.keys(builtinToolDefs);
		assert.deepStrictEqual(names.length, new Set(names).size);
	});

	test('у каждого инструмента есть непустое описание', () => {
		const withoutDescription = toolsDocRows().filter(row => row.summary.length === 0).map(row => row.name);
		assert.deepStrictEqual(withoutDescription, []);
	});

	test('порядок строк — как в реестре', () => {
		assert.deepStrictEqual(toolsDocRows().map(row => row.name), Object.keys(builtinToolDefs));
	});
});
