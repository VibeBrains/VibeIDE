/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isLegacyRefusal, refusedToolMessage, withRefusalKind } from '../../common/toolRefusal.js';

/**
 * A refused call carries no params: the edit card read `params.uri.fsPath` off the empty object of a guard's
 * `tool_error` and fell over. History stored before the `refused` kind is read into it.
 */
suite('toolRefusal — отказ предохранителя без params', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('отказ несёт причину модели и карточке, а params у него нет', () => {
		assert.deepStrictEqual(refusedToolMessage({ name: 'rewrite_file', id: 'c1', why: 'Anti-loop guard: …' }), {
			role: 'tool', type: 'refused', name: 'rewrite_file', result: 'Anti-loop guard: …', content: 'Anti-loop guard: …',
			id: 'c1', rawParams: {}, mcpServerName: undefined,
		});
	});

	test('старая история: пустые params у инструмента с параметрами — отказ; честная ошибка остаётся ошибкой', () => {
		const stored = (name: string, params: object, type = 'tool_error') => ({ role: 'tool', type, name, params, result: 'x' });
		assert.deepStrictEqual([
			isLegacyRefusal(stored('rewrite_file', {})),
			isLegacyRefusal(stored('read_file', {})),
			isLegacyRefusal(stored('invalid', {})),
			isLegacyRefusal(stored('rewrite_file', { uri: 'file:///a' })),
			// Declares no params and validates to `{}`: an empty object is its honest shape
			isLegacyRefusal(stored('design_doctor', {})),
			// An MCP tool: its params are the raw arguments, `{}` is a legitimate call
			isLegacyRefusal(stored('my_mcp_tool', {})),
			isLegacyRefusal(stored('rewrite_file', {}, 'success')),
		], [true, true, true, false, false, false, false]);
		assert.deepStrictEqual(withRefusalKind(stored('edit_file', {})), { role: 'tool', type: 'refused', name: 'edit_file', result: 'x' });
	});
});
