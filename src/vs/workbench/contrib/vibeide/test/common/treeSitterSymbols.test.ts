/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeSymbol, extractSymbols, qualifiedName, supportsSymbolExtraction, SyntaxNodeLike } from '../../common/codeSymbols/treeSitterSymbols.js';

/**
 * Declarations read out of a tree-sitter tree.
 *
 * The trees below copy shapes verified against the shipped PHP grammar — including the one that
 * matters most and is easy to get wrong: `namespace X;` without braces has no `body` child, and the
 * classes that follow are its SIBLINGS, not its children.
 */
suite('tree-sitter symbols', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Minimal stand-in for a tree-sitter node — the module reads nothing else. */
	function node(type: string, text: string, children: SyntaxNodeLike[] = [], fields: Record<string, SyntaxNodeLike> = {}): SyntaxNodeLike {
		return {
			type,
			text,
			startPosition: { row: 0, column: 0 },
			endPosition: { row: 0, column: 0 },
			namedChildCount: children.length,
			namedChild: (i: number) => children[i] ?? null,
			childForFieldName: (f: string) => fields[f] ?? null,
		};
	}

	const name = (text: string) => node('name', text);
	const decl = (type: string, text: string, children: SyntaxNodeLike[] = []) =>
		node(type, text, [name(text), ...children], { name: name(text) });

	const shown = (symbols: readonly CodeSymbol[]) => symbols.map(s => `${s.kind} ${qualifiedName(s)}`);

	/**
	 * The defect this test exists for: a bare `namespace` is a sibling of the classes it governs.
	 * Treating the tree literally loses the namespace off every class in a real project, and a jump
	 * to `App\Billing\Invoice` then finds nothing.
	 */
	test('a bare namespace governs the declarations that follow it', () => {
		const root = node('program', '', [
			node('namespace_definition', '', [node('namespace_name', 'App\\Billing')], { name: node('namespace_name', 'App\\Billing') }),
			decl('class_declaration', 'Invoice', [
				node('declaration_list', '', [
					decl('method_declaration', 'addLine'),
					node('property_declaration', '', [node('property_element', '', [node('variable_name', '$total')])]),
					node('const_declaration', '', [node('const_element', '', [name('STATUS')])]),
				]),
			]),
			decl('function_definition', 'helper'),
		]);

		assert.deepStrictEqual(shown(extractSymbols(root, 'php')), [
			'namespace App\\Billing',
			'class App\\Billing\\Invoice',
			'method App\\Billing\\Invoice::addLine',
			'property App\\Billing\\Invoice::$total',
			'constant App\\Billing\\Invoice::STATUS',
			'function App\\Billing\\helper',
		]);
	});

	/** The braced form nests for real, and must not be double-counted by the sibling rule. */
	test('a braced namespace nests through its body', () => {
		const inner = decl('class_declaration', 'Invoice');
		const body = node('compound_statement', '', [inner]);
		const root = node('program', '', [
			node('namespace_definition', '', [node('namespace_name', 'App'), body], { name: node('namespace_name', 'App'), body }),
			decl('class_declaration', 'Outside'),
		]);

		assert.deepStrictEqual(shown(extractSymbols(root, 'php')), [
			'namespace App',
			'class App\\Invoice',
			'class Outside',
		]);
	});

	/** Members use `::`, types use `\` — the same strings a caller would write in PHP. */
	test('qualified names follow PHP notation', () => {
		assert.strictEqual(qualifiedName({ name: 'pay', kind: 'method', container: ['App', 'Invoice'], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }), 'App\\Invoice::pay');
		assert.strictEqual(qualifiedName({ name: 'Invoice', kind: 'class', container: ['App'], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }), 'App\\Invoice');
		assert.strictEqual(qualifiedName({ name: 'helper', kind: 'function', container: [], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }), 'helper');
	});

	test('document order is preserved, and an unknown language yields nothing', () => {
		const root = node('program', '', [decl('function_definition', 'zeta'), decl('function_definition', 'alpha')]);
		assert.deepStrictEqual(extractSymbols(root, 'php').map(s => s.name), ['zeta', 'alpha']);
		assert.deepStrictEqual(extractSymbols(root, 'ruby'), []);
		assert.deepStrictEqual(extractSymbols(null, 'php'), []);
		assert.strictEqual(supportsSymbolExtraction('php'), true);
		assert.strictEqual(supportsSymbolExtraction('ruby'), false);
	});
});
