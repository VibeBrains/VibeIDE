/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	DEFAULT_COUPLING_THRESHOLDS,
	bugHistory,
	coupledWith,
	isCodeFix,
	isProductCode,
	parseCommitLog,
	type ICommitRecord,
} from '../../common/changeCoupling.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-14T00:00:00.000Z');

const commit = (files: string[], subject = 'feat: работа', daysAgo = 1): ICommitRecord =>
	({ hash: `h${daysAgo}${files.length}`, subject, whenMs: NOW - daysAgo * DAY, files });

suite('changeCoupling', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('классификация путей', () => {
		test('код против доков, тестов и конфигов', () => {
			assert.deepStrictEqual(
				['src/a.ts', 'docs/readme.md', 'src/a.test.ts', 'test/b.ts', 'package.json', 'src/test_utils/real.py', 'app/test_x.py']
					.map(isProductCode),
				[true, false, false, false, false, true, false]);
		});
	});

	suite('что считается починкой', () => {
		test('заголовок без кода починкой не считается', () => {
			assert.deepStrictEqual(
				[
					isCodeFix(commit(['docs/guide.md'], 'fix: опечатка в доке')),
					isCodeFix(commit(['src/a.test.ts'], 'fix: подкрутил тест')),
					isCodeFix(commit(['src/a.ts'], 'fix: падение на пустом вводе')),
					isCodeFix(commit(['src/a.ts'], 'feat: новая кнопка')),
					isCodeFix(commit(['src/a.ts'], 'исправлено падение')),
				],
				[false, false, true, false, true]);
		});
	});

	suite('связанные файлы', () => {
		const history = [
			commit(['src/api.ts', 'src/client.ts']),
			commit(['src/api.ts', 'src/client.ts']),
			commit(['src/api.ts', 'src/client.ts']),
			commit(['src/api.ts', 'src/unrelated.ts']),
		];

		test('устойчивая пара находится, единичное совпадение отсекается, входной файл не возвращается', () => {
			assert.deepStrictEqual(
				coupledWith(history, ['src/api.ts']).map(pair => [pair.file, pair.together, Math.round(pair.ratio * 100)]),
				[['src/client.ts', 3, 75]]);
		});

		test('массовый коммит связанности не создаёт', () => {
			const bulk = commit(Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`), 'chore: автоформат');
			assert.deepStrictEqual(coupledWith([bulk, bulk, bulk], ['src/f0.ts']), []);
		});

		test('файла нет в истории — пустой ответ, а не ошибка', () => {
			assert.deepStrictEqual(coupledWith(history, ['src/missing.ts']), []);
		});

		test('порог доли берётся из настроек', () => {
			const loose = { ...DEFAULT_COUPLING_THRESHOLDS, minPairCommits: 1, minPairRatio: 0.1 };
			assert.deepStrictEqual(
				coupledWith(history, ['src/api.ts'], loose).map(p => p.file),
				['src/client.ts', 'src/unrelated.ts']);
		});
	});

	suite('история починок', () => {
		test('считаются только починки кода в окне', () => {
			const history = [
				commit(['src/a.ts'], 'fix: падение', 10),
				commit(['src/a.ts'], 'fix: ещё падение', 20),
				commit(['src/a.ts'], 'feat: фича', 5),
				commit(['src/a.ts'], 'fix: старое падение', 300),
				commit(['docs/a.md'], 'fix: опечатка', 3),
			];
			assert.deepStrictEqual(
				bugHistory(history, ['src/a.ts', 'docs/a.md'], NOW),
				[{ file: 'src/a.ts', fixes: 2, lastFixDaysAgo: 10 }]);
		});

		test('файл без починок из ответа выпадает', () => {
			assert.deepStrictEqual(bugHistory([commit(['src/a.ts'], 'feat: x', 1)], ['src/a.ts'], NOW), []);
		});
	});

	suite('разбор git log', () => {
		test('заголовок с табуляцией и пустой коммит не ломают разбор', () => {
			const text = [
				'aaa\x0017560000\x00fix: пути\tи табуляция',
				'src/a.ts',
				'src/b.ts',
				'bbb\x0017550000\x00chore: пусто',
			].join('\n');
			assert.deepStrictEqual(parseCommitLog(text), [
				{ hash: 'aaa', subject: 'fix: пути\tи табуляция', whenMs: 17560000000, files: ['src/a.ts', 'src/b.ts'] },
				{ hash: 'bbb', subject: 'chore: пусто', whenMs: 17550000000, files: [] },
			]);
		});
	});
});
