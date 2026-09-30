/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dsmlVisibleLength, parseDsmlToolCalls } from '../../common/dsmlToolCalls.js';

/**
 * Разбор вызова в разметке DeepSeek сверяется с общими векторами (test/node/dsmlToolCallsVectors.test.ts)
 * Здесь — то, чего в векторах нет: сколько текста показывать, пока ответ ещё идёт, и шелл-черта в значении
 */
suite('dsmlToolCalls — показ потока и граница маркера', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('в потоке показывается только текст до разметки и до тега, который, возможно, начинается', () => {
		const shown = (text: string) => text.slice(0, dsmlVisibleLength(text));
		assert.deepStrictEqual([
			'Смотрю ветку.\n\n<｜DS',
			'Смотрю ветку.\n\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="git',
			'Смотрю ветку.\n< inv',
			'Смотрю ветку.\n</',
			'Если a < b, то ответ готов.',
			'Сравнение a < b и дальше текст, который длиннее любого начала тега, поэтому он уже не придерживается',
		].map(shown), [
			'Смотрю ветку.\n\n',
			'Смотрю ветку.\n\n',
			'Смотрю ветку.\n',
			'Смотрю ветку.\n',
			'Если a < b, то ответ готов.',
			'Сравнение a < b и дальше текст, который длиннее любого начала тега, поэтому он уже не придерживается',
		]);
	});

	test('обычная черта — не маркер: шелл-конвейер в значении доезжает целиком', () => {
		const text = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="run_command">\n<｜DSML｜parameter name="command" string="true">cat a |sort| uniq</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
		assert.deepStrictEqual(parseDsmlToolCalls(text).calls, [{ name: 'run_command', arguments: { command: 'cat a |sort| uniq' } }]);
	});
});
