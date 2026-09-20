/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { describeOcrPages, pageHeading, pageNeedsOcr } from '../../common/pdfTextLayer.js';

suite('pdfTextLayer — страница без текстового слоя не уезжает в контекст пустой', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('пустая страница и горсть мусора требуют распознавания, обычный текст — нет', () => {
		assert.deepStrictEqual([
			pageNeedsOcr(''),
			pageNeedsOcr(undefined),
			pageNeedsOcr('   \n  \t '),
			pageNeedsOcr('стр. 4'),
			pageNeedsOcr('Договор оказания услуг № 17 от 3 марта'),
		], [true, true, true, true, false]);
	});

	test('распознанная страница подписана, обычная — нет', () => {
		assert.deepStrictEqual(
			[pageHeading(3, true), pageHeading(3, false)],
			['[Страница 3 · распознано OCR]', '[Страница 3]'],
		);
	});

	/** Человек должен узнать про OCR до того, как модель ошибётся в цифре из таблицы. */
	test('предупреждение называет страницы, длинный список сворачивается', () => {
		assert.deepStrictEqual([
			describeOcrPages([]),
			describeOcrPages([2, 3]).includes('страницах: 2, 3'),
			describeOcrPages([1, 2, 3, 4, 5, 6, 7]).includes('1, 2, 3, 4, 5 и ещё 2'),
		], ['', true, true]);
	});
});
