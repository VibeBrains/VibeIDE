/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ancestryOf, collectMatches, createSymbolIndex, descendantsOf, enclosingContainerOf, IndexedSymbol, preferOpenBuffers, replaceFileSymbols } from '../../common/codeSymbols/codeIndexCore.js';
import { indexKeyOf } from '../../common/codeSymbols/treeSitterSymbols.js';
import { CodeSymbol, CodeSymbolKind } from '../../common/codeSymbols/treeSitterSymbols.js';

/**
 * The bookkeeping behind the declaration index.
 *
 * Both rules under test exist to avoid a user-visible wrong answer: a stale entry surviving a file's
 * rewrite sends the jump to a line that no longer holds the declaration, and a disk copy outranking
 * the open editor hides the method the user just typed.
 */
suite('code index core', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const sym = (name: string, kind: CodeSymbolKind = 'method', line = 0): CodeSymbol =>
		({ name, kind, container: [], startLine: line, startColumn: 0, endLine: line, endColumn: 0 });
	const names = (entries: readonly IndexedSymbol[]) => entries.map(e => `${e.file}:${e.symbol.name}@${e.symbol.startLine}`);

	test('replacing a file touches only that file', () => {
		const index = createSymbolIndex();
		replaceFileSymbols(index, 'a.php', [sym('pay', 'method', 10), sym('helper', 'function', 20)]);
		replaceFileSymbols(index, 'b.php', [sym('pay', 'method', 30)]);

		// `a.php` is rewritten: its old `helper` must vanish, `b.php` must be untouched.
		replaceFileSymbols(index, 'a.php', [sym('pay', 'method', 99)]);

		assert.deepStrictEqual({
			pay: names(index.byName.get('pay') ?? []),
			helper: names(index.byName.get('helper') ?? []),
			files: [...index.byFile.keys()],
		}, {
			pay: ['b.php:pay@30', 'a.php:pay@99'],
			helper: [],
			// Rewriting `a.php` keeps its place in the map — a re-`set` does not move a key.
			files: ['a.php', 'b.php'],
		});
	});

	/** A deletion is a replacement by nothing — no separate path, and no name left pointing at it. */
	test('a file with no declarations leaves nothing behind', () => {
		const index = createSymbolIndex();
		replaceFileSymbols(index, 'a.php', [sym('pay')]);
		replaceFileSymbols(index, 'a.php', []);
		assert.deepStrictEqual({ names: [...index.byName.keys()], files: [...index.byFile.keys()] }, { names: [], files: [] });
	});

	test('an open editor outranks the disk for its own file only', () => {
		const disk: IndexedSymbol[] = [
			{ file: 'open.php', symbol: sym('pay', 'method', 5) },
			{ file: 'other.php', symbol: sym('pay', 'method', 7) },
		];
		const open: IndexedSymbol[] = [{ file: 'open.php', symbol: sym('pay', 'method', 42) }];

		assert.deepStrictEqual(names(preferOpenBuffers(disk, open)), ['open.php:pay@42', 'other.php:pay@7'],
			'правка в редакторе перекрывает свой файл и не прячет остальные');
		assert.deepStrictEqual(names(preferOpenBuffers(disk, [])), ['open.php:pay@5', 'other.php:pay@7']);
	});

	/**
	 * The picker opens with an EMPTY query, so «no filter» must not mean «the whole project». It
	 * re-scores everything it is handed on every keystroke — the limit is what keeps a large
	 * repository from turning the feature into a stutter.
	 */
	test('the symbol search is filtered and bounded', () => {
		const byName = new Map<string, IndexedSymbol[]>();
		for (let i = 0; i < 50; i++) {
			byName.set(`name${i}`, [{ file: `f${i}.php`, symbol: sym(`name${i}`) }]);
		}
		byName.set('payInvoice', [{ file: 'inv.php', symbol: sym('payInvoice') }]);

		assert.strictEqual(collectMatches(byName, new Map(), '', 10).length, 10, 'пустой запрос ограничен пределом');
		assert.deepStrictEqual(names(collectMatches(byName, new Map(), 'PAYinv', 10)), ['inv.php:payInvoice@0'],
			'фильтр не зависит от регистра и ищет подстроку');
		assert.deepStrictEqual(collectMatches(byName, new Map(), 'нетакого', 10), []);
	});

	test('a declaration living only in an unsaved buffer is still findable', () => {
		const open = new Map<string, IndexedSymbol[]>([['brandNew', [{ file: 'draft.php', symbol: sym('brandNew') }]]]);
		assert.deepStrictEqual(names(collectMatches(new Map(), open, 'brand', 10)), ['draft.php:brandNew@0']);
	});

	/**
	 * PHP does not distinguish case in method names: `$this->ProcessInputData()` calls a method
	 * declared as `processInputData()`. Looking that up case-sensitively answers «определение не
	 * найдено» for code that runs perfectly well — which is exactly what a user reported.
	 */
	test('PHP names meet in one bucket regardless of case', () => {
		const key = (name: string) => indexKeyOf(name, 'php');
		const index = createSymbolIndex();
		replaceFileSymbols(index, 'base.php', [sym('processInputData')], key);

		assert.deepStrictEqual(names(index.byName.get(key('ProcessInputData')) ?? []), ['base.php:processInputData@0']);
		// The displayed name keeps the author's spelling — only the lookup key is normalised.
		assert.strictEqual(index.byName.get(key('PROCESSINPUTDATA'))?.[0].symbol.name, 'processInputData');

		// Case-sensitive languages are untouched: Go's `Pay` and `pay` are genuinely different.
		assert.notStrictEqual(indexKeyOf('Pay', 'go'), indexKeyOf('pay', 'go'));
		assert.strictEqual(indexKeyOf('Pay', 'go'), 'Pay');
	});

	/** Rewriting a file must clean up under the normalised key too, or stale entries survive. */
	test('a case-insensitive index cleans up on rewrite', () => {
		const key = (name: string) => indexKeyOf(name, 'php');
		const index = createSymbolIndex();
		replaceFileSymbols(index, 'a.php', [sym('ProcessInputData')], key);
		replaceFileSymbols(index, 'a.php', [], key);
		assert.deepStrictEqual({ names: [...index.byName.keys()], files: [...index.byFile.keys()] }, { names: [], files: [] });
	});

	/**
	 * What `$this` means at a given line. Shared by «go to definition» and completion — each used to
	 * carry its own copy, which is how two features start disagreeing about the same file.
	 */
	test('the enclosing type is the innermost one covering the line', () => {
		const type = (name: string, kind: CodeSymbolKind, startLine: number, endLine: number, container: string[] = []): CodeSymbol =>
			({ name, kind, container, startLine, startColumn: 0, endLine, endColumn: 0 });
		const symbols = [
			type('Outer', 'class', 0, 40),
			type('Inner', 'class', 10, 20, ['Outer']),
			type('pay', 'method', 12, 14, ['Outer', 'Inner']),
		];

		assert.deepStrictEqual({
			внутриВложенного: enclosingContainerOf(symbols, 13),
			толькоВнешний: enclosingContainerOf(symbols, 30),
			внеВсего: enclosingContainerOf(symbols, 99),
			наГранице: enclosingContainerOf(symbols, 20),
		}, {
			внутриВложенного: ['Outer', 'Inner'],
			толькоВнешний: ['Outer'],
			внеВсего: undefined,
			// The end line belongs to the declaration that ends there.
			наГранице: ['Outer', 'Inner'],
		});

		// A method is not a container: `$this` inside it still means the class.
		assert.deepStrictEqual(enclosingContainerOf([type('pay', 'method', 0, 5)], 3), undefined);
	});

	/**
	 * The inheritance chain, nearest first.
	 *
	 * This is what makes `$this->pay()` in a subclass find the parent's `pay` — the case the whole
	 * feature looked broken on: the method exists, but the index only knew the class's own members.
	 */
	test('the ancestry is ordered from the class outwards', () => {
		const bases = new Map<string, readonly string[]>([
			['Order', ['BaseController', 'Payable', 'HasRules']],
			['BaseController', ['Kernel']],
			['Kernel', []],
		]);
		assert.deepStrictEqual(ancestryOf('Order', bases), ['Order', 'BaseController', 'Payable', 'HasRules', 'Kernel']);
		assert.deepStrictEqual(ancestryOf('Kernel', bases), ['Kernel']);
		assert.deepStrictEqual(ancestryOf('Unknown', bases), ['Unknown'], 'неизвестный тип — сам себе цепочка');
	});

	/** Qualified bases are indexed under their last segment, and broken code may loop. */
	test('qualified names are shortened and cycles do not hang', () => {
		assert.deepStrictEqual(ancestryOf('Order', new Map([['Order', ['\\App\\Billing\\Base']]])), ['Order', 'Base']);
		const cyclic = new Map<string, readonly string[]>([['A', ['B']], ['B', ['A']]]);
		assert.deepStrictEqual(ancestryOf('A', cyclic), ['A', 'B'], 'цикл проходится один раз');
	});

	/**
	 * The path DOWN the hierarchy — «кто это реализует». Transitive on purpose: a class inheriting a
	 * subclass is a descendant too, and listing only the direct ones answers half the question.
	 */
	test('descendants are found through intermediate types', () => {
		const types = [
			{ name: 'Report', bases: ['BaseController'] },
			{ name: 'PdfReport', bases: ['Report'] },
			{ name: 'Invoice', bases: ['\\App\\Billing\\BaseController'] },
			{ name: 'Unrelated', bases: ['Something'] },
			{ name: 'NoBases' },
		];
		assert.deepStrictEqual(descendantsOf('BaseController', types), ['Report', 'Invoice', 'PdfReport'],
			'квалифицированное имя предка тоже засчитывается, потомки — по слоям');
		assert.deepStrictEqual(descendantsOf('Report', types), ['PdfReport']);
		assert.deepStrictEqual(descendantsOf('NoBases', types), []);
	});

	/** Broken code can loop; the walk must end rather than hang the editor. */
	test('a cycle among descendants terminates', () => {
		const cyclic = [{ name: 'A', bases: ['B'] }, { name: 'B', bases: ['A'] }];
		assert.deepStrictEqual(descendantsOf('A', cyclic), ['B']);
	});
});
