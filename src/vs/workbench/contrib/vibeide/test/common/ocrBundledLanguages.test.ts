/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { bundledTrainedDataPath, ocrLanguagesOf } from '../../common/imageQA/ocrBundledLanguages.js';
import { OCR_DEFAULT_LANGUAGES } from '../../common/imageQA/ocrTransport.js';

suite('ocrBundledLanguages — распознавание без сети', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('языки по умолчанию едут с приложением, чужой язык — нет, мусор в коде языка отбрасывается', () => {
		assert.deepStrictEqual({
			поУмолчанию: ocrLanguagesOf(OCR_DEFAULT_LANGUAGES).map(language => !!bundledTrainedDataPath(language)),
			повторИПробелы: ocrLanguagesOf(' rus + eng +rus'),
			китайский: [ocrLanguagesOf('chi_sim'), bundledTrainedDataPath('chi_sim')],
			выходИзПапки: ocrLanguagesOf('../../etc+eng'),
			путь: bundledTrainedDataPath('rus')?.endsWith('@tesseract.js-data/rus/4.0.0_best_int/rus.traineddata.gz'),
		}, {
			поУмолчанию: [true, true],
			повторИПробелы: ['rus', 'eng'],
			китайский: [['chi_sim'], undefined],
			выходИзПапки: ['eng'],
			путь: true,
		});
	});
});
