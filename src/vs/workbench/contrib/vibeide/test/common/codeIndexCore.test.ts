/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createSymbolIndex, IndexedSymbol, preferOpenBuffers, replaceFileSymbols } from '../../common/codeSymbols/codeIndexCore.js';
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
});
