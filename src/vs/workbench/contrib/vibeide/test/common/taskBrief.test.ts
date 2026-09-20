/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coverageOf, isCovered, MAX_REQUIREMENTS, parseBrief, waiveRequirement } from '../../common/taskBrief.js';

suite('taskBrief — требования задачи в словах человека', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const at = 1_700_000_000_000;

	test('ГЛАВНЫЙ ИНВАРИАНТ: каждая цитата — дословная подстрока исходного текста', () => {
		const texts = [
			'Почини падение при старте.\nДобавь тест.\nОбнови доки.',
			'- вынести конфиг в отдельный файл\n- покрыть тестами\n- описать в спеке',
			'Нужно разобраться, почему не запускается сборка? И починить её!',
			'1) поправить линтер\n2) прогнать тесты\n3) закоммитить',
		];
		const broken: string[] = [];
		for (const text of texts) {
			const brief = parseBrief(text, 'b1', at);
			for (const r of brief.requirements) {
				if (brief.text.slice(r.start, r.end) !== r.quote) {
					broken.push(`${r.id}: «${r.quote}» ≠ «${brief.text.slice(r.start, r.end)}»`);
				}
			}
		}
		assert.deepStrictEqual(broken, []);
	});

	test('список побеждает: маркер не попадает в цитату', () => {
		const brief = parseBrief('Задача:\n- вынести конфиг в отдельный файл\n- покрыть тестами разбор\n', 'b1', at);
		assert.deepStrictEqual(brief.requirements.map(r => ({ id: r.id, quote: r.quote })), [
			{ id: 'r1', quote: 'вынести конфиг в отдельный файл' },
			{ id: 'r2', quote: 'покрыть тестами разбор' },
		]);
	});

	test('списка нет — предложения, и строка без точки тоже предложение', () => {
		// Владелец пишет «одна мысль — одна строка», без точек в конце: разбор обязан это понимать.
		const brief = parseBrief('Почини падение при старте\nДобавь тест на этот случай', 'b1', at);
		assert.deepStrictEqual(brief.requirements.map(r => r.quote), [
			'Почини падение при старте',
			'Добавь тест на этот случай',
		]);
	});

	test('короткие обрывки требованиями не считаются', () => {
		const brief = parseBrief('Да. Ок. Почини падение при старте приложения.', 'b1', at);
		assert.deepStrictEqual(brief.requirements.map(r => r.quote), ['Почини падение при старте приложения.']);
	});

	test('точка внутри слова предложение не рвёт', () => {
		const brief = parseBrief('Вынеси настройки в .vibe/config.json и опиши формат', 'b1', at);
		assert.deepStrictEqual(brief.requirements.map(r => r.quote), ['Вынеси настройки в .vibe/config.json и опиши формат']);
	});

	test('длинный список обрезается потолком, а не уходит стеной', () => {
		const text = Array.from({ length: MAX_REQUIREMENTS + 10 }, (_, i) => `- требование номер ${i + 1} подлиннее`).join('\n');
		assert.strictEqual(parseBrief(text, 'b1', at).requirements.length, MAX_REQUIREMENTS);
	});

	test('покрытие двустороннее: и обещанное без исполнителя, и работа без заказа', () => {
		const brief = parseBrief('- вынести конфиг в файл\n- покрыть тестами разбор\n- описать формат в спеке', 'b1', at);
		const coverage = coverageOf(brief, [
			{ stepNumber: 1, requirementIds: ['r1'] },
			{ stepNumber: 2, requirementIds: ['r9'] },   // опечатка: такого требования нет
			{ stepNumber: 3 },                            // работа, о которой не просили
			{ stepNumber: 4, requirementIds: ['r2'], disabled: true }, // выключенный шаг не покрывает
		]);
		assert.deepStrictEqual({
			непокрыто: coverage.uncovered.map(r => r.id),
			шагиБезТребования: coverage.unlinkedSteps,
			битыеСсылки: coverage.unknownRefs,
			можноОдобрять: isCovered(coverage),
		}, {
			непокрыто: ['r2', 'r3'],
			шагиБезТребования: [3],
			битыеСсылки: ['r9'],
			можноОдобрять: false,
		});
	});

	test('снятое человеком покрытия не требует и одобрению не мешает', () => {
		const brief = parseBrief('- вынести конфиг в файл\n- описать формат в спеке', 'b1', at);
		const after = waiveRequirement(brief, 'r2', 'спеку пишем отдельной задачей', at)!;
		const coverage = coverageOf(after, [{ stepNumber: 1, requirementIds: ['r1'] }]);
		assert.deepStrictEqual({
			снято: coverage.waived.map(r => r.id),
			кто: after.requirements[1].waived?.by,
			причина: after.requirements[1].waived?.reason,
			непокрыто: coverage.uncovered.map(r => r.id),
			можноОдобрять: isCovered(coverage),
		}, {
			снято: ['r2'], кто: 'user', причина: 'спеку пишем отдельной задачей',
			непокрыто: [], можноОдобрять: true,
		});
	});

	test('снятие без причины и снятие несуществующего отвергаются', () => {
		const brief = parseBrief('- вынести конфиг в файл\n- описать формат в спеке', 'b1', at);
		const waived = waiveRequirement(brief, 'r1', 'уже сделано ранее', at)!;
		assert.deepStrictEqual({
			// «Вычеркнуто без объяснения» через месяц неотличимо от забытого.
			безПричины: waiveRequirement(brief, 'r1', '   ', at),
			несуществующее: waiveRequirement(brief, 'r7', 'причина', at),
			повторно: waiveRequirement(waived, 'r1', 'ещё раз', at),
			// Снятие не правит бриф на месте: исходный остаётся нетронутым.
			исходныйЦел: brief.requirements[0].waived,
		}, { безПричины: undefined, несуществующее: undefined, повторно: undefined, исходныйЦел: undefined });
	});
});
