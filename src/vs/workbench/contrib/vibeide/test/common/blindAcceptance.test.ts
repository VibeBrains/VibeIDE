/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildAcceptanceGoal, parseAcceptance, summarizeAcceptance } from '../../common/blindAcceptance.js';
import { parseBrief, waiveRequirement } from '../../common/taskBrief.js';

suite('blindAcceptance — приёмка видит только задачу', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const at = 1_700_000_000_000;
	const brief = parseBrief('- вынести конфиг в отдельный файл\n- покрыть тестами разбор\n- описать формат в спеке', 'b1', at);

	test('в задании приёмщику есть текст задачи и требования цитатами', () => {
		const goal = buildAcceptanceGoal(brief, ['src/config.ts', 'src/config.test.ts']);
		assert.deepStrictEqual({
			текстЗадачи: goal.includes('вынести конфиг в отдельный файл'),
			всеТребования: brief.requirements.every(r => goal.includes(`${r.id}. ${r.quote}`)),
			файлы: goal.includes('- src/config.ts'),
			форматОтвета: goal.includes('met | unmet | unverifiable'),
			// Приёмщик не чинит работу: иначе он перестаёт быть независимым и становится соавтором.
			неЧинить: goal.includes('Не чини'),
		}, { текстЗадачи: true, всеТребования: true, файлы: true, форматОтвета: true, неЧинить: true });
	});

	test('снятые человеком названы, чтобы не попасть в невыполненные', () => {
		const waived = waiveRequirement(brief, 'r3', 'спеку пишем отдельно', at)!;
		const goal = buildAcceptanceGoal(waived, ['src/config.ts']);
		assert.deepStrictEqual({
			названоСнятым: goal.includes('СНЯТЫ ЧЕЛОВЕКОМ (проверять не нужно): r3'),
			// Снятое требование не предлагается к проверке как живое.
			неВСписке: !goal.includes('r3. описать формат в спеке'),
		}, { названоСнятым: true, неВСписке: true });
	});

	test('пустой список изменений — сам по себе ответ', () => {
		assert.ok(buildAcceptanceGoal(brief, []).includes('ИЗМЕНЁННЫХ ФАЙЛОВ НЕТ'));
	});

	test('молчание приёмщика — «не проверено», а не «выполнено»', () => {
		const lines = parseAcceptance('r1 | met | вынесено в src/config.ts\nr2 | unmet | тестов нет', brief.requirements);
		assert.deepStrictEqual(lines, [
			{ id: 'r1', verdict: 'met', note: 'вынесено в src/config.ts' },
			{ id: 'r2', verdict: 'unmet', note: 'тестов нет' },
			// Про r3 приёмщик не сказал ничего — подставлять согласие нельзя.
			{ id: 'r3', verdict: 'unverifiable', note: 'приёмщик не сказал об этом требовании ничего' },
		]);
	});

	test('снятые в разбор не попадают, а сводка называет вещи своими именами', () => {
		const waived = waiveRequirement(brief, 'r3', 'спеку пишем отдельно', at)!;
		const lines = parseAcceptance('r1 | MET | ок\nr2 | unmet | нет', waived.requirements);
		assert.deepStrictEqual({
			сколько: lines.length,
			регистрНеВажен: lines[0].verdict,
			сводка: summarizeAcceptance(lines),
		}, { сколько: 2, регистрНеВажен: 'met', сводка: 'выполнено 1 из 2 · не выполнено 1' });
	});
});
