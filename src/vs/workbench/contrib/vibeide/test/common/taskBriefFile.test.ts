/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseBrief, waiveRequirement } from '../../common/taskBrief.js';
import { parseBriefFile, serializeBrief } from '../../common/taskBriefFile.js';

suite('taskBriefFile — бриф на диске', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const at = 1_700_000_000_000;
	const brief = parseBrief('- вынести конфиг в отдельный файл\n- покрыть тестами разбор\n- описать формат в спеке', 'b7', at);

	test('запись и чтение не теряют ни текста, ни требований', () => {
		const back = parseBriefFile(serializeBrief(brief))!;
		assert.deepStrictEqual({
			id: back.id,
			текст: back.text === brief.text,
			требования: back.requirements.map(r => ({ id: r.id, quote: r.quote, start: r.start, end: r.end })),
		}, {
			id: 'b7',
			текст: true,
			требования: brief.requirements.map(r => ({ id: r.id, quote: r.quote, start: r.start, end: r.end })),
		});
	});

	test('снятое требование переживает круг через диск вместе с причиной', () => {
		const waived = waiveRequirement(brief, 'r3', 'спеку пишем отдельной задачей', at)!;
		const back = parseBriefFile(serializeBrief(waived))!;
		const r3 = back.requirements.find(r => r.id === 'r3')!;
		assert.deepStrictEqual({ кто: r3.waived?.by, причина: r3.waived?.reason, остальныеЦелы: back.requirements.filter(r => r.waived).length },
			{ кто: 'user', причина: 'спеку пишем отдельной задачей', остальныеЦелы: 1 });
	});

	test('цитата ВОССТАНАВЛИВАЕТСЯ из текста, а не читается из строки списка', () => {
		// Правка цитаты руками не должна разойтись с текстом молча: источник правды один.
		const tampered = serializeBrief(brief).replace('вынести конфиг в отдельный файл —', 'ПОДМЕНА —')
			.replace('r1 (0–31) вынести конфиг в отдельный файл', 'r1 (0–31) ПОДМЕНЕННАЯ ЦИТАТА');
		const back = parseBriefFile(tampered)!;
		assert.strictEqual(back.requirements[0].quote, 'вынести конфиг в отдельный файл');
	});

	test('требование со смещением за пределы текста отбрасывается, а не пустеет', () => {
		// Строка r2 целиком заменяется на такую же, но со смещениями за пределы текста.
		const r2 = brief.requirements[1];
		const broken = serializeBrief(brief)
			.replace(`r2 (${r2.start}–${r2.end})`, 'r2 (9000–9001)');
		const back = parseBriefFile(broken)!;
		assert.deepStrictEqual(back.requirements.map(r => r.id), ['r1', 'r3']);
	});

	test('чужой файл читается как чужой, а не как пустой бриф', () => {
		assert.deepStrictEqual({
			чужой: parseBriefFile('# Просто заметка\n\nтекст'),
			пустой: parseBriefFile(''),
		}, { чужой: undefined, пустой: undefined });
	});
});
