/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { currentTaskOf, taskReminderLine } from '../../common/autopilotNudge.js';

suite('autopilotNudge — какую задачу называет авто-продолжение', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('задача — последняя просьба человека, а не оборвавшийся прежний ход', () => {
		// Ровно случай из жалобы 20.09.2026: прежний ход упёрся в предохранитель, человек попросил
		// другое, и «продолжай поставленную работу» уводило модель обратно в прежнюю задачу.
		const messages = [
			{ role: 'user', content: 'обнови плагины Android для 16 KB pages' },
			{ role: 'assistant', content: 'делаю…' },
			{ role: 'user', content: '⚙️ Авто-продолжение (автопилот): ход не закрывается текстом', isSyntheticNudge: true },
			{ role: 'assistant', content: '⛔ Агент не запущен: сработал защитный предохранитель.' },
			{ role: 'user', content: 'посмотри почему перестал запускаться скрипт npm run build:android:prod' },
		];
		assert.deepStrictEqual({
			задача: currentTaskOf(messages),
			// Синтетическая подсказка задачей быть не может — иначе автопилот цитировал бы сам себя.
			безПросьб: currentTaskOf([{ role: 'user', content: 'nudge', isSyntheticNudge: true }, { role: 'assistant', content: 'x' }]),
			пусто: currentTaskOf([]),
		}, {
			задача: 'посмотри почему перестал запускаться скрипт npm run build:android:prod',
			безПросьб: undefined,
			пусто: undefined,
		});
	});

	test('напоминание называет задачу дословно и не раздувает подсказку', () => {
		const long = 'a'.repeat(400);
		const line = taskReminderLine('  проверь   сборку\n  андроида  ');
		assert.deepStrictEqual({
			// Переносы и двойные пробелы схлопнуты: подсказка остаётся одной читаемой строкой.
			текст: line.includes('«проверь сборку андроида»'),
			предупреждение: line.includes('задачей не является'),
			обрезано: taskReminderLine(long).includes('…'),
			// Целиком длинная задача в подсказку не попадает — только узнаваемое начало.
			длина: !taskReminderLine(long).includes('a'.repeat(301)),
			// Называть нечего — строки нет вовсе, а не пустые кавычки.
			безЗадачи: taskReminderLine(undefined),
			пробелы: taskReminderLine('   '),
		}, { текст: true, предупреждение: true, обрезано: true, длина: true, безЗадачи: '', пробелы: '' });
	});
});
