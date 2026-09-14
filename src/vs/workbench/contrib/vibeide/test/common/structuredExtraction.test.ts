/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cleanHtmlForExtraction, extractionRequestBody, isUsableSchema, parseExtractionAnswer } from '../../common/structuredExtraction.js';

/**
 * Извлечение по схеме: модель инструкций не принимает, поэтому весь контракт — в HTML и схеме.
 */
suite('structuredExtraction — HTML и схема на вход, JSON на выход', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('из HTML уходят скрипты, стили, комментарии и метатеги; длинная страница обрезается с пометкой', () => {
		const page = '<html><head><meta charset="utf-8"><style>p{}</style><script>track()</script></head><body><!-- x --><p>Цена:  <b>100</b></p></body></html>';
		assert.deepStrictEqual(
			[cleanHtmlForExtraction(page), cleanHtmlForExtraction('<p>1234567890</p>', 5)],
			[{ html: '<html><head></head><body><p>Цена: <b>100</b></p></body></html>', truncated: false }, { html: '<p>12', truncated: true }],
		);
	});

	test('тело запроса — схема в response_format со strict и нулевая температура', () => {
		const schema = { type: 'object', properties: { price: { type: 'number' } } };
		assert.deepStrictEqual(extractionRequestBody(schema), {
			response_format: { type: 'json_schema', json_schema: { name: 'extraction', schema, strict: true } },
			temperature: 0,
		});
	});

	test('ответ разбирается как JSON, блок в тройных кавычках допускается, проза — нет', () => {
		assert.deepStrictEqual(
			[
				parseExtractionAnswer('{"price": 100}'),
				parseExtractionAnswer('```json\n{"price": 100}\n```'),
				parseExtractionAnswer('Цена — сто рублей'),
				parseExtractionAnswer('  '),
			],
			[
				{ ok: true, data: { price: 100 } },
				{ ok: true, data: { price: 100 } },
				{ ok: false, reason: 'ответ модели — не JSON' },
				{ ok: false, reason: 'модель вернула пустой ответ' },
			],
		);
	});

	test('схема — объект с type или properties; массив и пустой объект не схема', () => {
		assert.deepStrictEqual(
			[isUsableSchema({ type: 'object' }), isUsableSchema({ properties: {} }), isUsableSchema([]), isUsableSchema({})],
			[true, true, false, false],
		);
	});
});
