/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AcpEditLedger, decodeBaseline, isInsideRoot, normalizeEol, resolveBaseline } from '../../common/acp/acpEditBaseline.js';

/**
 * Какой текст файла берётся за «до», когда агент правит файлы сам
 * От этого зависит, что вернёт «Отклонить»: неверная база превращает отмену правки в порчу файла
 */
suite('acpEditBaseline', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('чтение базы', () => {
		test('UTF-8 читается как есть, метка порядка байтов снимается', () => {
			const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('привет')]);
			assert.deepStrictEqual([decodeBaseline(bytes), decodeBaseline(new TextEncoder().encode('мир'))], ['привет', 'мир']);
		});

		test('не UTF-8 — базы нет: прочитанное мусором отличалось бы от модели в каждой строке', () => {
			assert.strictEqual(decodeBaseline(new Uint8Array([0xCF, 0xD0, 0xC8, 0xC2, 0xC5, 0xD2])), undefined);
		});

		test('переводы строк сводятся к \\n, как в модели редактора', () => {
			assert.strictEqual(normalizeEol('а\r\nб\rв\nг'), 'а\nб\nв\nг');
		});

		test('читать можно только то, что в рабочей папке сессии', () => {
			assert.deepStrictEqual(
				[
					isInsideRoot('/ws/app', '/ws/app/src/a.ts'),
					isInsideRoot('/ws/app', '/ws/app'),
					isInsideRoot('/ws/app', '/ws/other/a.ts'),
					isInsideRoot('/ws/app', '/ws/app/../other/a.ts'),
					isInsideRoot('/ws/app', '/ws/app-2/a.ts'),
					isInsideRoot('/ws/app', 'src/a.ts'),
				],
				[true, true, false, false, false, false]);
		});
	});

	suite('журнал баз хода', () => {
		test('первое касание файла задаёт базу, последующие её не переписывают', () => {
			const ledger = new AcpEditLedger();
			ledger.remember([{ path: '/ws/a.ts', state: 'text', text: 'один' }]);
			ledger.remember([{ path: '/ws/a.ts', state: 'text', text: 'один и правка' }, { path: '/ws/b.ts', state: 'absent' }]);
			assert.deepStrictEqual([ledger.baselineOf('/ws/a.ts'), ledger.baselineOf('/ws/b.ts'), ledger.baselineOf('/ws/c.ts')], ['один', null, undefined]);
		});

		test('новый ход начинает с чистого листа', () => {
			const ledger = new AcpEditLedger();
			ledger.remember([{ path: '/ws/a.ts', state: 'text', text: 'один' }]);
			ledger.clear();
			assert.strictEqual(ledger.baselineOf('/ws/a.ts'), undefined);
		});

		test('база с переводами CRLF сводится к \\n', () => {
			const ledger = new AcpEditLedger();
			ledger.remember([{ path: '/ws/a.ts', state: 'text', text: 'а\r\nб' }]);
			assert.strictEqual(ledger.baselineOf('/ws/a.ts'), 'а\nб');
		});
	});

	suite('база правки', () => {
		const edit = { path: '/ws/a.ts', oldText: 'return 1;', newText: 'return 2;' };

		test('снятая до правки база и есть «до», когда диск уже другой', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: 'function f() {\n\treturn 1;\n}\n', current: 'function f() {\n\treturn 2;\n}\n', diff: edit }),
				{ kind: 'text', text: 'function f() {\n\treturn 1;\n}\n' });
		});

		test('файла до хода не было — это созданный файл', () => {
			assert.deepStrictEqual(resolveBaseline({ remembered: null, current: 'новый\n' }), { kind: 'created' });
		});

		test('создан и пуст — разбирать нечего', () => {
			assert.deepStrictEqual(resolveBaseline({ remembered: null, current: '' }), { kind: 'skip', reason: 'unchanged' });
		});

		test('вторая правка того же файла в ходу держится за базу начала хода, а не за результат первой', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: 'a\nb\n', current: 'a\nB\nC\n', diff: { path: '/ws/a.ts', oldText: 'B', newText: 'B\nC' } }),
				{ kind: 'text', text: 'a\nb\n' });
		});

		test('база совпала с диском — вызов успел записать файл раньше, чем его прочли: «до» восстанавливается по диффу', () => {
			const current = 'function f() {\n\treturn 2;\n}\n';
			assert.deepStrictEqual(
				resolveBaseline({ remembered: current, current, diff: edit }),
				{ kind: 'text', text: 'function f() {\n\treturn 1;\n}\n' });
		});

		test('базы нет вовсе — та же обратная подстановка', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: undefined, current: 'x = 2;\n', diff: { path: '/ws/a.ts', oldText: 'x = 1;', newText: 'x = 2;' } }),
				{ kind: 'text', text: 'x = 1;\n' });
		});

		test('обратная подстановка не гадает: новый текст встречается дважды — правка на разбор не идёт', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: undefined, current: 'return 2;\nreturn 2;\n', diff: edit }),
				{ kind: 'skip', reason: 'ambiguous' });
		});

		test('запись файла целиком (oldText пуст) без базы не восстановить: угаданная база опустошила бы файл при отклонении', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: undefined, current: 'всё содержимое\n', diff: { path: '/ws/a.ts', oldText: '', newText: 'всё содержимое\n' } }),
				{ kind: 'skip', reason: 'ambiguous' });
		});

		test('база совпала с диском и дифф ничего не меняет — разбирать нечего', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: 'а\n', current: 'а\n', diff: { path: '/ws/a.ts', oldText: 'а', newText: 'а' } }),
				{ kind: 'skip', reason: 'unchanged' });
		});

		test('удаление текста (newText пуст) без базы не восстановить: место удалённого неизвестно', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: undefined, current: 'a\n', diff: { path: '/ws/a.ts', oldText: 'b', newText: '' } }),
				{ kind: 'skip', reason: 'ambiguous' });
		});

		test('диск с CRLF сравнивается с базой по \\n', () => {
			assert.deepStrictEqual(
				resolveBaseline({ remembered: 'а\nб\n', current: 'а\r\nВ\r\n' }),
				{ kind: 'text', text: 'а\nб\n' });
		});
	});
});
