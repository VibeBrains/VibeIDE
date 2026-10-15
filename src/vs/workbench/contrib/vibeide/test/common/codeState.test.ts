/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isInsideCode } from '../../common/codeState.js';

suite('codeState — где стоит символ относительно кода', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Whether the marker `@` in `text` stands inside code; the marker itself is cut out */
	const atMarker = (text: string): boolean => isInsideCode(text.replace('@', ''), text.indexOf('@'));

	test('блок кода и строчный фрагмент — код, текст до и после них — нет', () => {
		assert.deepStrictEqual([
			'текст @ без кода',
			'до\n```\nкод @ внутри\n```\nпосле',
			'до\n```\nкод\n```\nпосле @ блока',
			'слово `в @ ячейке` дальше',
			'слово `в ячейке` дальше @',
			'  ```\n  отступ @\n  ```',
		].map(atMarker), [false, true, false, true, false, true]);
	});

	test('строчный фрагмент не переходит на новую строку, а внутри блока обратные кавычки ничего не открывают', () => {
		assert.deepStrictEqual([
			'открыл ` и забыл\nследующая @ строка',
			'```\nодна ` кавычка\n@\n```',
		].map(atMarker), [false, true]);
	});
});
