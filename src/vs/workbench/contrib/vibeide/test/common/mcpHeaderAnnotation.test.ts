/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { filterToolsWithValidHeaders, rejectToolReason } from '../../common/mcpHeaderAnnotation.js';

const tool = (name: string, properties: Record<string, unknown>) => ({ name, inputSchema: { type: 'object', properties } });

suite('mcpHeaderAnnotation — инструмент с негодным именем заголовка не попадает в список', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('годное описание проходит; отсутствие аннотации ничему не мешает', () => {
		assert.deepStrictEqual([
			rejectToolReason(tool('sql', { region: { type: 'string', 'x-mcp-header': 'Region' }, query: { type: 'string' } })),
			rejectToolReason(tool('plain', { query: { type: 'string' } })),
			rejectToolReason({ name: 'no-schema' }),
		], [undefined, undefined, undefined]);
	});

	/** Перевод строки в имени заголовка — это внедрение чужого заголовка, а не опечатка. */
	test('пустое имя, перевод строки, повтор, запрещённый тип и слишком большое целое — отказ', () => {
		const reasons = [
			tool('a', { p: { type: 'string', 'x-mcp-header': '' } }),
			tool('b', { p: { type: 'string', 'x-mcp-header': 'Bad\r\nInjected: 1' } }),
			tool('c', { p: { type: 'string', 'x-mcp-header': 'Region' }, q: { type: 'string', 'x-mcp-header': 'region' } }),
			tool('d', { p: { type: 'number', 'x-mcp-header': 'Weight' } }),
			tool('e', { p: { type: 'integer', maximum: 2 ** 60, 'x-mcp-header': 'Size' } }),
		].map(rejectToolReason);
		assert.deepStrictEqual(reasons.map(reason => reason !== undefined), [true, true, true, true, true]);
	});

	test('битое описание уносит только себя, остальные инструменты остаются', () => {
		const result = filterToolsWithValidHeaders([
			tool('good', { p: { type: 'string', 'x-mcp-header': 'Region' } }),
			tool('bad', { p: { type: 'string', 'x-mcp-header': 'плохое имя' } }),
		]);
		assert.deepStrictEqual(
			[result.tools.map(item => item.name), result.rejected.map(item => item.name)],
			[['good'], ['bad']],
		);
	});
});
