/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseTextToolCalls, TextToolMarkupFilter } from '../../common/textToolCalls.js';

/**
 * Разбор вызова, написанного текстом, сверяется с общими векторами (test/node/textToolCallsVectors.test.ts)
 * Здесь — то, чего в векторах нет: сколько текста показывать, пока ответ ещё идёт, шелл-черта в значении
 * и имена, которые есть у любого объекта JavaScript
 */
suite('textToolCalls — показ потока, граница маркера, имена объекта', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('в потоке показывается только текст до разметки и до тега, который, возможно, начинается', () => {
		const stream = (text: string) => {
			const filter = new TextToolMarkupFilter();
			filter.accept(text);
			const shown = filter.shown;
			const held = filter.finish();
			return { shown, held, final: filter.shown };
		};
		assert.deepStrictEqual([
			'Смотрю ветку.\n\n<｜DS',
			'Смотрю ветку.\n\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="git',
			'Смотрю ветку.\n< inv',
			'Смотрю ветку.\n</',
			'Если a < b, то ответ готов.',
			'Сравнение a < b и дальше текст, который длиннее любого начала тега, поэтому он уже не придерживается',
		].map(stream), [
			// A tail that may grow into an opener waits; once the answer ends without one, it is the answer's own
			{ shown: 'Смотрю ветку.\n\n', held: undefined, final: 'Смотрю ветку.\n\n<｜DS' },
			{ shown: 'Смотрю ветку.\n\n', held: '<｜DSML｜function_calls>\n<｜DSML｜invoke name="git', final: 'Смотрю ветку.\n\n' },
			{ shown: 'Смотрю ветку.\n', held: undefined, final: 'Смотрю ветку.\n< inv' },
			{ shown: 'Смотрю ветку.\n', held: undefined, final: 'Смотрю ветку.\n</' },
			// A `<` not yet closed waits only while it is short enough to be a tag's start
			{ shown: 'Если a ', held: undefined, final: 'Если a < b, то ответ готов.' },
			{
				shown: 'Сравнение a < b и дальше текст, который длиннее любого начала тега, поэтому он уже не придерживается',
				held: undefined,
				final: 'Сравнение a < b и дальше текст, который длиннее любого начала тега, поэтому он уже не придерживается',
			},
		]);
	});

	test('обычная черта — не маркер: шелл-конвейер в значении доезжает целиком', () => {
		const text = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="run_command">\n<｜DSML｜parameter name="command" string="true">cat a |sort| uniq</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜function_calls>';
		assert.deepStrictEqual(parseTextToolCalls(text, { run_command: undefined }).calls, [{ name: 'run_command', arguments: { command: 'cat a |sort| uniq' } }]);
	});

	test('имя, которое есть у любого объекта, — не предложенный инструмент, а ключ `__proto__` — обычный аргумент', () => {
		const offered = { run_command: { type: 'object', properties: {} } };
		const inherited = parseTextToolCalls('<tool_call>\n{"name": "constructor", "arguments": {}}\n</tool_call>', offered);
		const protoKey = parseTextToolCalls('<tool_call>\n<function=run_command>\n<parameter=__proto__>\nx\n</parameter>\n</function>\n</tool_call>', offered);
		assert.deepStrictEqual({
			inherited: inherited.outcome,
			protoKeys: Object.keys(protoKey.calls[0]?.arguments ?? {}),
			prototypeKept: Object.getPrototypeOf(protoKey.calls[0]?.arguments) === Object.prototype,
		}, {
			inherited: 'text',
			protoKeys: ['__proto__'],
			prototypeKept: true,
		});
	});
});
