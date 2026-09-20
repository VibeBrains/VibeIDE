/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coerceFieldValue, parseElicitationParams, planInputRequests, rootsAnswer } from '../../common/mcpElicitation.js';

suite('mcpElicitation — вопрос сервера, адресованный человеку', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('схема разбирается в форму: подписи, типы, обязательность', () => {
		const form = parseElicitationParams({
			message: 'Подтвердите доступ к репозиторию',
			requestedSchema: {
				type: 'object',
				properties: {
					repo: { type: 'string', title: 'Репозиторий', description: 'owner/name' },
					branch: { type: 'string', enum: ['main', 'next'] },
					count: { type: 'integer' },
					force: { type: 'boolean' },
				},
				required: ['repo'],
			},
		});
		assert.deepStrictEqual(form, {
			message: 'Подтвердите доступ к репозиторию',
			fields: [
				{ key: 'repo', label: 'Репозиторий', description: 'owner/name', type: 'string', required: true },
				// Перечисление узнаётся по `enum`, а не по объявленному типу: так его и показывают списком.
				{ key: 'branch', label: 'branch', type: 'enum', options: ['main', 'next'], required: false },
				{ key: 'count', label: 'count', type: 'integer', required: false },
				{ key: 'force', label: 'force', type: 'boolean', required: false },
			],
		});
	});

	test('пустая просьба не считается отвеченной', () => {
		assert.deepStrictEqual({
			пусто: parseElicitationParams({}),
			неОбъект: parseElicitationParams('нет'),
			// Одного сообщения довольно: это вопрос «да или нет».
			толькоСообщение: parseElicitationParams({ message: 'Продолжить?' })?.fields.length,
		}, { пусто: undefined, неОбъект: undefined, толькоСообщение: 0 });
	});

	test('план: человеку — вопрос, окну — папки, сэмплингу — отказ', () => {
		const plan = planInputRequests([
			{ key: 'a', method: 'elicitation/create', params: { message: 'Введите ключ' } },
			{ key: 'b', method: 'roots/list', params: {} },
			// Сэмплинг объявлен устаревшим той же ревизией, что ввела MRTR, — не отвечаем.
			{ key: 'c', method: 'sampling/createMessage', params: {} },
		]);
		assert.deepStrictEqual({
			человеку: plan.elicitations.map(e => e.request.key),
			окну: plan.roots.map(r => r.key),
			неУмеем: plan.unsupported,
		}, { человеку: ['a'], окну: ['b'], неУмеем: ['sampling/createMessage'] });
	});

	test('значения приводятся к типу, а неразбираемое число остаётся строкой', () => {
		const field = (type: 'string' | 'number' | 'integer' | 'boolean') => ({ key: 'k', label: 'k', type, required: false } as const);
		assert.deepStrictEqual({
			булево: coerceFieldValue(field('boolean'), 'true'),
			целое: coerceFieldValue(field('integer'), '42'),
			дробное: coerceFieldValue(field('number'), '1.5'),
			// Подменять «два» нулём значило бы отправить серверу число, которого человек не вводил.
			неЧисло: coerceFieldValue(field('number'), 'два'),
			строка: coerceFieldValue(field('string'), '42'),
			папки: rootsAnswer([{ uri: 'file:///repo', name: 'repo' }]),
		}, {
			булево: true, целое: 42, дробное: 1.5, неЧисло: 'два', строка: '42',
			папки: { roots: [{ uri: 'file:///repo', name: 'repo' }] },
		});
	});
});
