/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SymbolKind } from '../../../../../editor/common/languages.js';
import { toOutline } from '../../browser/vibePhpSymbolsContribution.js';
import { CodeSymbol, CodeSymbolKind } from '../../common/codeSymbols/treeSitterSymbols.js';

/**
 * Flat declarations → the tree the outline draws.
 *
 * The interesting part is that nesting comes from the container path, not from source ranges: a
 * bare `namespace X;` occupies one line and does not span the classes it governs, so containment by
 * range would put every one of them outside their own namespace.
 */
suite('php outline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let line = 0;
	const sym = (name: string, kind: CodeSymbolKind, container: string[] = []): CodeSymbol => ({
		name, kind, container,
		startLine: line++, startColumn: 0, endLine: line, endColumn: 0,
	});

	const shape = (nodes: readonly { name: string; children?: readonly unknown[] }[]): unknown =>
		nodes.map(n => (n.children && n.children.length > 0
			? { [n.name]: shape(n.children as { name: string; children?: readonly unknown[] }[]) }
			: n.name));

	test('members nest under their class even when the namespace spans nothing', () => {
		line = 0;
		const outline = toOutline([
			sym('App\\Billing', 'namespace'),
			sym('Invoice', 'class', ['App\\Billing']),
			sym('addLine', 'method', ['App\\Billing', 'Invoice']),
			sym('STATUS', 'constant', ['App\\Billing', 'Invoice']),
			sym('helper', 'function', ['App\\Billing']),
		]);

		// Namespace становится узлом структуры, а не просто префиксом имени: в аутлайне видно
		// пространство имён с его содержимым, как и объявлено в файле.
		assert.deepStrictEqual(shape(outline), [
			{ 'App\\Billing': [{ 'Invoice': ['addLine', 'STATUS'] }, 'helper'] },
		]);
	});

	/** Ranges are 1-based in the editor and 0-based in tree-sitter — an off-by-one here misplaces every jump. */
	test('positions are converted to the editor’s 1-based lines', () => {
		line = 0;
		const [only] = toOutline([{ name: 'helper', kind: 'function', container: [], startLine: 4, startColumn: 2, endLine: 6, endColumn: 1 }]);
		assert.deepStrictEqual(
			{ l: only.range.startLineNumber, c: only.range.startColumn, el: only.range.endLineNumber, ec: only.range.endColumn },
			{ l: 5, c: 3, el: 7, ec: 2 },
		);
		assert.deepStrictEqual(only.selectionRange, only.range);
	});

	test('kinds map onto what the outline can draw, with trait shown as a class', () => {
		line = 0;
		const kinds = toOutline([sym('A', 'class'), sym('I', 'interface'), sym('T', 'trait'), sym('E', 'enum')]).map(s => s.kind);
		assert.deepStrictEqual(kinds, [SymbolKind.Class, SymbolKind.Interface, SymbolKind.Class, SymbolKind.Enum]);
	});

	/**
	 * A file that declares the same class twice is broken PHP, but it must not break the outline:
	 * letting the second declaration capture the children would move half the file under it.
	 */
	test('a redeclared container does not steal the children of the first', () => {
		line = 0;
		const outline = toOutline([
			sym('Dup', 'class'),
			sym('first', 'method', ['Dup']),
			sym('Dup', 'class'),
			sym('second', 'method', ['Dup']),
		]);
		assert.deepStrictEqual(shape(outline), [{ 'Dup': ['first', 'second'] }, 'Dup']);
	});

	test('an empty file yields an empty outline', () => {
		assert.deepStrictEqual(toOutline([]), []);
	});
});
