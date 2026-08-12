/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { buildUiKitDraft } from '../../common/designContext/uiKitDraft.js';

suite('uiKitDraft — карта, снятая с кода', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('токены, классы и компоненты попадают каждый в свой слой', () => {
		const draft = buildUiKitDraft([
			{ path: 'src/styles/tokens.css', content: ':root { --color-accent: #f60; --space-2: 8px; }' },
			{ path: 'src/styles/portal.css', content: '.btn { color: red } .card, .badge > .badge__dot { }' },
			{ path: 'src/components/ui.tsx', content: 'export function Card() {}\nexport const Toast = () => {}\nexport default function Page() {}' },
		], 'demo');
		assert.deepStrictEqual(
			draft.layers.map(l => ({ layer: l.layer, file: l.file })),
			// Порядок — от «нельзя выдумывать» к «уже написано», а не порядок файлов на входе.
			[
				{ layer: 'Токены', file: 'src/styles/tokens.css' },
				{ layer: 'Компоненты (CSS)', file: 'src/styles/portal.css' },
				{ layer: 'Примитивы интерфейса', file: 'src/components/ui.tsx' },
			],
		);
		assert.deepStrictEqual(
			draft.names,
			['--color-accent', '--space-2', '.btn', '.card', '.badge', '.badge__dot', 'Card', 'Page', 'Toast'],
		);
	});

	test('утилитарные классы не засоряют карту', () => {
		// Сослаться в задаче на `.mt-4` бессмысленно, а сотня таких имён прячет настоящие.
		const draft = buildUiKitDraft([
			{ path: 'app.css', content: '.mt-4 {} .flex {} .text-sm {} .rounded-lg {} .hero-card {}' },
		], 'demo');
		assert.deepStrictEqual(draft.names, ['.hero-card']);
	});

	test('файл, который ничего не объявляет, в таблицу не попадает', () => {
		// Строка «этот файл пуст» — шум, из-за которого перестают читать всю таблицу.
		const draft = buildUiKitDraft([
			{ path: 'src/util/helpers.ts', content: 'export const clamp = (n: number) => n;' },
			{ path: 'src/styles/reset.css', content: 'html, body { margin: 0 }' },
		], 'demo');
		assert.deepStrictEqual({ layers: draft.layers.length, names: draft.names }, { layers: 0, names: [] });
	});

	test('пустой результат говорит словами, а не пустой таблицей', () => {
		const draft = buildUiKitDraft([], 'demo');
		assert.ok(draft.markdown.includes('не нашлось ни токенов'));
		assert.ok(!draft.markdown.includes('| Слой |'), 'заголовок таблицы без строк выглядит как проделанная работа');
	});

	test('длинный список имён обрезается со счётчиком, а не молча', () => {
		const many = Array.from({ length: 20 }, (_, i) => `--token-${i}: 0;`).join(' ');
		const draft = buildUiKitDraft([{ path: 'tokens.css', content: `:root { ${many} }` }], 'demo');
		assert.ok(draft.layers[0].contains.includes('и ещё 8'), draft.layers[0].contains);
		assert.strictEqual(draft.names.length, 20, 'обрезается показ, а не сам список имён');
	});

	test('слои идут в постоянном порядке независимо от порядка файлов', () => {
		// Повторный сбор должен давать тот же файл, иначе каждый прогон — шумный дифф.
		const draft = buildUiKitDraft([
			{ path: 'z/comp.tsx', content: 'export function Widget() {}' },
			{ path: 'a/style.css', content: '.hero {}' },
			{ path: 'm/tokens.css', content: ':root { --x: 1px }' },
		], 'demo');
		assert.deepStrictEqual(draft.layers.map(l => l.layer), ['Токены', 'Компоненты (CSS)', 'Компоненты']);
	});
});
