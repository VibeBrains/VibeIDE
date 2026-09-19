/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import { toolParamUri } from '../../common/toolParamUri.js';

suite('toolParamUri — отказ, который называет себя', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('путь возвращается как есть; без пути — ошибка с именем инструмента и пришедшими полями', () => {
		const uri = URI.file('/repo/src/app.ts');
		const errorOf = (params: unknown): string => {
			try { toolParamUri('read_file', params); return '(ошибки не было)'; }
			catch (e) { return e instanceof Error ? e.message : String(e); }
		};
		assert.deepStrictEqual({
			путьЕсть: toolParamUri('read_file', { uri, startLine: 1 }) === uri,
			// Симптом «Cannot read properties of undefined (reading 'fsPath')» не называл ни
			// инструмента, ни того, что пришло вместо пути.
			поляНет: errorOf({ start_line: 282, end_line: 295 }),
			строкаВместоПути: errorOf({ uri: '/repo/src/app.ts' }),
			параметровНет: errorOf(undefined),
		}, {
			путьЕсть: true,
			поляНет: 'Инструмент «read_file» вызван без пути: параметр uri — поля нет. Пришедшие поля: start_line, end_line.',
			строкаВместоПути: 'Инструмент «read_file» вызван без пути: параметр uri — string. Пришедшие поля: uri.',
			параметровНет: 'Инструмент «read_file» вызван без пути: параметр uri — поля нет. Пришедшие поля: (ни одного).',
		});
	});
});
