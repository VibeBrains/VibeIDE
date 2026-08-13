/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentHandoff, parseHandoff, renderHandoff, validateHandoff } from '../../common/agentHandoff.js';

const HANDOFF: AgentHandoff = {
	title: 'Мультимодельный скан',
	done: ['слияние находок по согласию', '9 тестов'],
	blockers: ['живого ключа второго провайдера нет'],
	next: ['прогнать на реальном диффе'],
	environment: 'ветка next, дерево чистое',
	from: 'тред 42',
	createdAtMs: Date.UTC(2026, 7, 12, 10, 0, 0),
};

suite('agentHandoff — передача работы между агентами', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('рендер и разбор — круговой рейс без потерь', () => {
		const parsed = parseHandoff(renderHandoff(HANDOFF));
		assert.deepStrictEqual(
			[parsed?.title, parsed?.done, parsed?.blockers, parsed?.next, parsed?.environment, parsed?.from],
			[HANDOFF.title, HANDOFF.done, HANDOFF.blockers, HANDOFF.next, HANDOFF.environment, HANDOFF.from],
		);
	});

	test('пустой раздел печатается явно, а не пропускается', () => {
		const text = renderHandoff({ ...HANDOFF, blockers: [] });
		assert.match(text, /## Блокеры\n- — не указано/);
	});

	test('заглушка пустого раздела не возвращается пунктом — иначе она станет выдуманной задачей', () => {
		const parsed = parseHandoff(renderHandoff({ ...HANDOFF, blockers: [] }));
		assert.deepStrictEqual(parsed?.blockers, []);
	});

	test('чужие заголовки узнаются по синонимам, незнакомые разделы игнорируются', () => {
		const foreign = [
			'# Задача про кэш',
			'## What was done',
			'- поправил ключи',
			'## Next steps',
			'- измерить попадания',
			'## Мысли вслух',
			'- это не раздел протокола',
		].join('\n');
		const parsed = parseHandoff(foreign);
		assert.deepStrictEqual([parsed?.title, parsed?.done, parsed?.next, parsed?.blockers], ['Задача про кэш', ['поправил ключи'], ['измерить попадания'], []]);
	});

	test('пустой текст — не хендофф, а не хендофф с пустыми полями', () => {
		assert.deepStrictEqual([parseHandoff(''), parseHandoff('   \n\n')], [undefined, undefined]);
	});

	test('проверка называет именно то, чего не хватает, и не мешает записи', () => {
		assert.deepStrictEqual(
			[validateHandoff(HANDOFF), validateHandoff({ ...HANDOFF, next: [], done: [] }).length],
			[[], 2],
		);
	});
});
