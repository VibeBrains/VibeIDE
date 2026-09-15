/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { googleThoughtSignatureOf, googleThoughtSignatureOptions, signatureOfFunctionCallParts, withoutThoughtSignatures } from '../../common/thoughtSignature.js';
import { isMcpToolAllowedByEntry } from '../../common/mcpToolAllowlist.js';
import { isFloatingModel } from '../../common/modelCapabilities.js';
import { formatCouncilResult } from '../../common/modelCouncil.js';

/**
 * Подпись мысли Gemini 3 возвращается с вызовом инструмента; список tools сервера MCP и плавающие модели.
 */
suite('thoughtSignature — подпись мысли, список инструментов MCP, плавающая модель', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('подпись читается с части вызова и из метаданных AI SDK, возвращается опциями', () => {
		assert.deepStrictEqual([
			signatureOfFunctionCallParts([{ text: 'думаю' }, { functionCall: { name: 'read_file' }, thoughtSignature: 'sig-1' }]),
			signatureOfFunctionCallParts([{ functionCall: { name: 'read_file' } }]),
			signatureOfFunctionCallParts(undefined),
			googleThoughtSignatureOf({ google: { thoughtSignature: 'sig-2' } }),
			googleThoughtSignatureOf({ openai: {} }),
			googleThoughtSignatureOptions('sig-3'),
			googleThoughtSignatureOptions(undefined),
		], ['sig-1', undefined, undefined, 'sig-2', undefined, { providerOptions: { google: { thoughtSignature: 'sig-3' } } }, {}]);
	});

	test('для модели без требования подпись снимается из tool_use и functionCall, остальное не трогается', () => {
		const history = [
			{ role: 'user', content: 'сделай' },
			{ role: 'assistant', content: [{ type: 'text', text: 'читаю' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {}, thoughtSignature: 'sig' }] },
			{ role: 'model', parts: [{ functionCall: { id: 't1', name: 'read_file', args: {} }, thoughtSignature: 'sig' }] },
		];
		assert.deepStrictEqual(withoutThoughtSignatures(history), [
			{ role: 'user', content: 'сделай' },
			{ role: 'assistant', content: [{ type: 'text', text: 'читаю' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
			{ role: 'model', parts: [{ functionCall: { id: 't1', name: 'read_file', args: {} } }] },
		]);
	});

	test('список tools записи MCP: нет списка — всё, пустой — ничего, имена точные', () => {
		assert.deepStrictEqual([
			isMcpToolAllowedByEntry(undefined, 'search'),
			isMcpToolAllowedByEntry({}, 'search'),
			isMcpToolAllowedByEntry({ tools: ['search', 'fetch'] }, 'fetch'),
			isMcpToolAllowedByEntry({ tools: ['search'] }, 'delete_page'),
			isMcpToolAllowedByEntry({ tools: ['Search'] }, 'search'),
			isMcpToolAllowedByEntry({ tools: [] }, 'search'),
		], [true, true, true, false, false, false]);
	});

	test('плавающая модель: объявлена в файле или разрешается каталогом в другой id; совет её помечает', () => {
		assert.deepStrictEqual(
			[isFloatingModel({ floating: true }), isFloatingModel({ floatsTo: 'deepseek/deepseek-v4.1-flash' }), isFloatingModel({}), isFloatingModel({ floatsTo: '' })],
			[true, true, false, false],
		);
		const text = formatCouncilResult({ question: 'Вопрос' }, { opinions: [{ providerName: 'openRouter', modelName: '~deepseek/deepseek-flash-latest', text: 'да', durationMs: 1000, floating: true }], summary: undefined });
		assert.ok(text.includes('~deepseek/deepseek-flash-latest (плавающий алиас)'));
	});
});
