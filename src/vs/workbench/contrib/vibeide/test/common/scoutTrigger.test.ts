/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { isContinuationRequest, buildScoutGoal, hasAgentWorkSinceLastUserMessage } from '../../common/scoutTrigger.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Vibe Agents — scout trigger', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('continuation markers fire; plain self-contained requests do not', () => {
		assert.deepStrictEqual(
			[
				'продолжи', 'продолжай с того же места', 'дальше', 'доделай форму', 'заверши начатое',
				'continue', 'keep going', 'finish it',
			].map(isContinuationRequest),
			[true, true, true, true, true, true, true, true],
		);
		assert.deepStrictEqual(
			['добавь кнопку логина', 'почини баг в парсере', 'запусти тесты', 'напиши функцию сортировки'].map(isContinuationRequest),
			[false, false, false, false],
		);
	});

	test('фраза продолжения должна быть (почти) всем сообщением', () => {
		// Сообщение со скрина 19.09: слово-триггер есть, но контекст пользователь принёс сам —
		// разведывать нечего, а прогон модели стоил бы денег и задержки перед ответом.
		const сСвоимКонтекстом = [
			'опять упал на ошибке TypeError: Cannot read properties of undefined (reading \'fsPath\')\n\nпродолжи действия\n\nпосле того как решишь все действия по этой задаче - поищи почему ты падаешь по такой ошибке',
			'продолжи работу над формой, но сначала перенеси валидацию в отдельный модуль и покрой её тестами',
		].map(isContinuationRequest);
		const голыеПродолжения = [
			'продолжи', 'продолжи действия', 'дальше', 'продолжай с того же места', 'continue', 'keep going',
		].map(isContinuationRequest);
		assert.deepStrictEqual({ сСвоимКонтекстом, голыеПродолжения }, {
			сСвоимКонтекстом: [false, false],
			голыеПродолжения: [true, true, true, true, true, true],
		});
	});

	test('работа агента после прошлого сообщения пользователя отменяет разведку', () => {
		assert.deepStrictEqual({
			// Агент только что работал при человеке — его ход и есть контекст.
			толькоЧтоРаботал: hasAgentWorkSinceLastUserMessage(['user', 'assistant', 'tool', 'user']),
			// Пауза: прошлый ход кончился на сообщении пользователя, работы после него нет.
			праздныйТред: hasAgentWorkSinceLastUserMessage(['user', 'user']),
			// Первое сообщение в треде — разведывать тем более нечего, но и работы нет.
			первоеСообщение: hasAgentWorkSinceLastUserMessage(['user']),
			// Чекпоинты работой не считаются: их ставит сама IDE, а не агент.
			толькоЧекпоинты: hasAgentWorkSinceLastUserMessage(['user', 'checkpoint', 'user']),
			пустойТред: hasAgentWorkSinceLastUserMessage([]),
		}, {
			толькоЧтоРаботал: true,
			праздныйТред: false,
			первоеСообщение: false,
			толькоЧекпоинты: false,
			пустойТред: false,
		});
	});

	test('scout goal includes changed files, plan, and always asks for leads + hypothesis', () => {
		const withContext = buildScoutGoal('продолжи', ['src/a.ts', 'src/b.ts'], 'Шаг 2 из 3 не завершён');
		const noContext = buildScoutGoal('продолжи', [], undefined);
		assert.deepStrictEqual(
			{
				withHasFiles: withContext.includes('src/a.ts, src/b.ts'),
				withHasPlan: withContext.includes('Шаг 2 из 3'),
				withAsksLeads: withContext.includes('гипотезу'),
				noContextFallback: noContext.includes('Явного контекста'),
				noContextAsksLeads: noContext.includes('гипотезу'),
			},
			{ withHasFiles: true, withHasPlan: true, withAsksLeads: true, noContextFallback: true, noContextAsksLeads: true },
		);
	});
});
