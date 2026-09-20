/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { stripUnknownContentBlocks } from '../../common/anthropicStrictBlocks.js';

suite('anthropicStrictBlocks — строгое подмножество для совместимых апстримов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('незнакомый тип блока убирается и называется; знакомое не трогается', () => {
		const result = stripUnknownContentBlocks([
			// Тот самый случай: блок, который настоящий Anthropic знает, а прокси — нет,
			// и отвергает из-за него ВЕСЬ запрос (регрессия Claude Code 2.1.275).
			{ role: 'user', content: [{ type: 'text', text: 'привет' }, { type: 'advisor_20260301', data: 'x' }] },
			{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'tool_use', id: '1' }] },
			// Строковое содержимое сужать нечего.
			{ role: 'user', content: 'просто строка' },
		]);
		assert.deepStrictEqual({
			dropped: result.dropped,
			первое: (result.messages[0] as { content: unknown[] }).content,
			второеЦело: (result.messages[1] as { content: unknown[] }).content.length,
			строкаЦела: (result.messages[2] as { content: unknown }).content,
		}, {
			dropped: ['advisor_20260301'],
			первое: [{ type: 'text', text: 'привет' }],
			второеЦело: 2,
			строкаЦела: 'просто строка',
		});
	});

	test('сообщение, опустевшее после фильтра, остаётся — роли в диалоге не сдвигаются', () => {
		const result = stripUnknownContentBlocks([{ role: 'assistant', content: [{ type: 'advisor_20260301' }] }]);
		assert.deepStrictEqual({
			сообщений: result.messages.length,
			блоков: (result.messages[0] as { content: unknown[] }).content.length,
			dropped: result.dropped,
		}, { сообщений: 1, блоков: 0, dropped: ['advisor_20260301'] });
	});
});
