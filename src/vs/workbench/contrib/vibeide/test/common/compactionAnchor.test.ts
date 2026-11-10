/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildTaskSourceBlock, PRESERVE_NOTE_MAX_CHARS } from '../../common/compactionAnchor.js';

suite('compactionAnchor — опора задачи после сжатия', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('короткий бриф попадает в блок целиком', () => {
		assert.deepStrictEqual(
			buildTaskSourceBlock({ text: 'Починить кнопку «Отправить».\nНе менять API.', path: '.vibe/plans/abc.brief.md' }),
			'<task_source>\nБриф задачи (полный текст — .vibe/plans/abc.brief.md):\nПочинить кнопку «Отправить».\nНе менять API.\n</task_source>',
		);
	});

	test('длинный бриф режется по строке и называет путь к полному тексту', () => {
		const line = 'я'.repeat(100);
		const text = Array.from({ length: 80 }, () => line).join('\n');
		const kept = Array.from({ length: 59 }, () => line).join('\n');
		assert.deepStrictEqual(
			buildTaskSourceBlock({ text, path: '.vibe/plans/big.brief.md' }),
			`<task_source>\nБриф задачи (полный текст — .vibe/plans/big.brief.md):\n${kept}\nбриф обрезан, полный текст — .vibe/plans/big.brief.md\n</task_source>`,
		);
	});

	test('пустой ввод не создаёт блок', () => {
		assert.deepStrictEqual({
			безБрифа: buildTaskSourceBlock(undefined),
			пустойТекст: buildTaskSourceBlock({ text: '   ', path: '.vibe/plans/empty.brief.md' }),
			пустаяЗаметка: buildTaskSourceBlock(undefined, ' \n '),
		}, { безБрифа: '', пустойТекст: '', пустаяЗаметка: '' });
	});

	test('заметка «что сохранить» идёт тем же блоком после брифа', () => {
		assert.deepStrictEqual(
			buildTaskSourceBlock({ text: 'Сделать X.', path: '.vibe/plans/note.brief.md' }, 'Не трогать Y.'),
			'<task_source>\nБриф задачи (полный текст — .vibe/plans/note.brief.md):\nСделать X.\n\nЧто сохранить после сжатия:\nНе трогать Y.\n</task_source>',
		);
	});

	test('длинная заметка тоже режется по лимиту', () => {
		const block = buildTaskSourceBlock(undefined, 'я'.repeat(PRESERVE_NOTE_MAX_CHARS + 10));
		assert.deepStrictEqual({
			влезло: block.includes('я'.repeat(PRESERVE_NOTE_MAX_CHARS)),
			хвост: block.includes('заметка обрезана'),
		}, { влезло: true, хвост: true });
	});
});
