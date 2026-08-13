/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	DEFAULT_DIFFICULTY_THRESHOLDS,
	NextDifficulty,
	isMissionReady,
	missingMissionQuestions,
	nextDifficulty,
	parseMission,
	parseRecord,
	renderMission,
	renderRecord,
	summarizeLearning,
	type ILearningRecord,
} from '../../common/learningWorkspace.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const record = (stuck: string[], learned: string[] = ['что-то'], at = 1): ILearningRecord =>
	({ lesson: `урок ${at}`, learned, stuck, createdAtMs: at });

suite('learningWorkspace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('миссия', () => {
		test('разбор наших заголовков и синонимов', () => {
			const mission = parseMission([
				'# Миссия обучения',
				'## Цель',
				'Веду переговоры на английском',
				'## Уровень',
				'Читаю документацию свободно',
				'## Success criteria',
				'Провёл встречу без переводчика',
				'## Как учиться',
				'Короткие уроки и разбор ошибок',
			].join('\n'));
			assert.deepStrictEqual(mission, {
				why: 'Веду переговоры на английском',
				level: 'Читаю документацию свободно',
				success: 'Провёл встречу без переводчика',
				format: 'Короткие уроки и разбор ошибок',
			});
		});

		test('заглушка пустого раздела и комментарий образца не считаются ответом', () => {
			const mission = parseMission('## Зачем\n— не указано\n## Уровень\n<!-- впишите сюда -->');
			assert.deepStrictEqual(
				[mission.why, mission.level, isMissionReady(mission), missingMissionQuestions(mission).length],
				['', '', false, 4]);
		});

		test('рендер читается собственным разбором', () => {
			const mission = { why: 'а', level: 'б', success: 'в', format: 'г' };
			assert.deepStrictEqual(parseMission(renderMission(mission)), mission);
		});
	});

	suite('следы обучения', () => {
		test('рендер читается собственным разбором', () => {
			const source: ILearningRecord = {
				lesson: 'Артикли',
				learned: ['a/an перед исчисляемыми'],
				stuck: ['нулевой артикль'],
				createdAtMs: Date.parse('2026-08-13T10:00:00.000Z'),
			};
			assert.deepStrictEqual(parseRecord(renderRecord(source)), source);
		});

		test('пустой файл и файл без содержания дают undefined', () => {
			assert.deepStrictEqual([parseRecord(''), parseRecord('# Урок\n## Освоено\n- — не указано')?.learned], [undefined, []]);
		});
	});

	suite('сложность следующего урока', () => {
		test('без записей — держим уровень: судить не по чему', () => {
			assert.strictEqual(nextDifficulty([]).difficulty, NextDifficulty.Hold);
		});

		test('чистая серия длиной с порог — усложняем', () => {
			assert.strictEqual(
				nextDifficulty([record([], ['a'], 1), record([], ['b'], 2)]).difficulty,
				NextDifficulty.Harder);
		});

		test('одной чистой записи при пороге 2 мало', () => {
			assert.strictEqual(nextDifficulty([record([], ['a'], 1)]).difficulty, NextDifficulty.Hold);
		});

		test('повтор темы перекрывает чистую серию и возвращает к теме', () => {
			const verdict = nextDifficulty([
				record(['Условные предложения'], ['a'], 1),
				record(['условные предложения!'], ['b'], 2),
				record([], ['c'], 3),
				record([], ['d'], 4),
			]);
			assert.deepStrictEqual(
				[verdict.difficulty, verdict.revisit],
				[NextDifficulty.Easier, ['Условные предложения']]);
		});

		test('повтор внутри одного урока — одна трудность, а не две', () => {
			assert.strictEqual(
				nextDifficulty([record(['артикли', 'Артикли.'], ['a'], 1)]).difficulty,
				NextDifficulty.Hold);
		});

		test('разные трудности без повтора — держим уровень', () => {
			assert.strictEqual(
				nextDifficulty([record(['артикли'], ['a'], 1), record(['времена'], ['b'], 2)]).difficulty,
				NextDifficulty.Hold);
		});

		test('порог усложнения берётся из настроек, а не из литерала', () => {
			assert.strictEqual(
				nextDifficulty([record([], ['a'], 1)], { ...DEFAULT_DIFFICULTY_THRESHOLDS, cleanRunForHarder: 1 }).difficulty,
				NextDifficulty.Harder);
		});
	});

	suite('сводка', () => {
		test('неполная миссия закрывает обучение и называет недостающие вопросы', () => {
			const summary = summarizeLearning({
				missionMarkdown: '## Зачем\nХочу писать тесты',
				lessonCount: 0,
				recordMarkdowns: [],
			});
			assert.deepStrictEqual(
				[summary.missionReady, summary.missingQuestions.length, summary.records.length, summary.verdict.difficulty],
				[false, 3, 0, NextDifficulty.Hold]);
		});

		test('битый файл записи не роняет сводку, а выпадает из неё', () => {
			const summary = summarizeLearning({
				missionMarkdown: renderMission({ why: 'а', level: 'б', success: 'в', format: 'г' }),
				lessonCount: 2,
				recordMarkdowns: ['', renderRecord(record([], ['a'], 1)), '   '],
			});
			assert.deepStrictEqual([summary.missionReady, summary.records.length, summary.lessonCount], [true, 1, 2]);
		});
	});
});
