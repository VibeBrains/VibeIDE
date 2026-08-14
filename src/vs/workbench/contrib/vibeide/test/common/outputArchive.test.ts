/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ARCHIVE_MIN_CHARS, OutputArchive, archiveMarker, normalizeRef } from '../../common/outputArchive.js';
import { compressCommandOutput, detectCommandKind } from '../../common/commandOutputCompressor.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const big = (line: string, times: number): string => Array.from({ length: times }, (_, i) => `${line} ${i}`).join('\n');
const raw = big('строка вывода', 400);

suite('outputArchive', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('кладёт длинный вывод и разворачивает его целиком', () => {
		const archive = new OutputArchive();
		const ref = archive.store('npm test', raw, 'сжато', 1);
		assert.ok(ref);
		const expanded = archive.expand(ref!);
		assert.deepStrictEqual(
			[expanded.found, expanded.command, expanded.totalLines, expanded.text?.split('\n')[0]],
			[true, 'npm test', 400, 'строка вывода 0']);
	});

	test('короткий вывод и несжатый вывод не архивируются', () => {
		const archive = new OutputArchive();
		assert.deepStrictEqual(
			[
				archive.store('ls', 'коротко', 'коротко', 1),
				archive.store('ls', 'x'.repeat(ARCHIVE_MIN_CHARS + 1), 'x'.repeat(ARCHIVE_MIN_CHARS + 1), 1),
			],
			[undefined, undefined]);
	});

	test('фильтр по подстроке возвращает только нужные строки', () => {
		const archive = new OutputArchive();
		const ref = archive.store('pytest', `${raw}\nFAILED test_foo`, 'сжато', 1)!;
		const found = archive.expand(ref, 'failed');
		assert.deepStrictEqual([found.totalLines, found.text], [1, 'FAILED test_foo']);
	});

	test('вытесненная ссылка отвечает объяснением, а не пустотой', () => {
		const archive = new OutputArchive(2);
		const first = archive.store('a', raw, 'c', 1)!;
		archive.store('b', raw, 'c', 2);
		archive.store('c', raw, 'c', 3);
		const gone = archive.expand(first);
		assert.deepStrictEqual([gone.found, archive.size, gone.message.includes('не найден')], [false, 2, true]);
	});

	test('ссылка узнаётся и в виде целой метки из вывода', () => {
		const archive = new OutputArchive();
		const ref = archive.store('npm test', raw, 'сжато', 1)!;
		const marker = archiveMarker(ref, raw, 'сжато');
		assert.deepStrictEqual(
			[normalizeRef(`[vibe#${ref}: 399 строк свёрнуто]`), archive.expand(marker).found],
			[ref, true]);
	});
});

suite('commandOutputCompressor — новые профили', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('семейство команды определяется по инструменту и по имени скрипта', () => {
		assert.deepStrictEqual(
			['eslint src', 'tsgo --noEmit', 'rg foo', 'npm run typecheck', 'npm run build', 'npm run test', 'npm run dev', 'make all']
				.map(detectCommandKind),
			['lint', 'lint', 'search', 'lint', 'build', 'test', 'unknown', 'build']);
	});

	test('линтер: ошибки дословно, предупреждения свёрнуты в группу', () => {
		const output = [
			'src/a.ts:1:1  error  Нельзя так  no-any',
			...Array.from({ length: 30 }, (_, i) => `src/b.ts:${i}:1  warning  Мелочь  prefer-const`),
			'✖ 31 problems (1 error, 30 warnings)',
		].join('\n');
		const compressed = compressCommandOutput('eslint src', output, true);
		assert.deepStrictEqual(
			[
				compressed.includes('error  Нельзя так'),
				compressed.includes('prefer-const: 30 warnings'),
				compressed.split('\n').length < 10,
			],
			[true, true, true]);
	});

	test('поиск: флуд группируется по файлам, первые совпадения остаются', () => {
		const output = Array.from({ length: 40 }, (_, i) => `src/a.ts:${i}:совпадение`).join('\n');
		const compressed = compressCommandOutput('rg совпадение', output, true);
		assert.deepStrictEqual(
			[compressed.includes('src/a.ts:0:совпадение'), compressed.includes('+37 more matches')],
			[true, true]);
	});

	test('ни одна строка с ошибкой не теряется ни в одном профиле', () => {
		const commands = ['eslint src', 'npm run build', 'rg foo', 'npm test', 'git status', 'pip install x', 'docker build .', 'ls -la'];
		const survived = commands.map(command => {
			const output = [
				...Array.from({ length: 40 }, (_, i) => `шум ${i}`),
				'error: пропасть нельзя',
				...Array.from({ length: 40 }, (_, i) => `src/x.ts:${i}:1  warning  шум  rule`),
			].join('\n');
			return compressCommandOutput(command, output, true).includes('error: пропасть нельзя');
		});
		assert.deepStrictEqual(survived, commands.map(() => true));
	});
});
