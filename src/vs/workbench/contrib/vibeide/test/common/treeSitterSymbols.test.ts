/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CodeSymbol, extensionsOf, extractSymbols, grammarNameOf, isInsideSpans, nonCodeSpans, qualifiedName, supportsSymbolExtraction, symbolLanguageIds, SyntaxNodeLike } from '../../common/codeSymbols/treeSitterSymbols.js';

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

	const shown = (symbols: readonly CodeSymbol[], languageId = 'php') => symbols.map(s => `${s.kind} ${qualifiedName(s, languageId)}`);

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
		assert.strictEqual(qualifiedName({ name: 'pay', kind: 'method', container: ['App', 'Invoice'], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, 'php'), 'App\\Invoice::pay');
		assert.strictEqual(qualifiedName({ name: 'Invoice', kind: 'class', container: ['App'], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, 'php'), 'App\\Invoice');
		assert.strictEqual(qualifiedName({ name: 'helper', kind: 'function', container: [], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 }, 'php'), 'helper');
	});

	test('document order is preserved, and an unknown language yields nothing', () => {
		const root = node('program', '', [decl('function_definition', 'zeta'), decl('function_definition', 'alpha')]);
		assert.deepStrictEqual(extractSymbols(root, 'php').map(s => s.name), ['zeta', 'alpha']);
		assert.deepStrictEqual(extractSymbols(root, 'kotlin'), []);
		assert.deepStrictEqual(extractSymbols(null, 'php'), []);
		assert.strictEqual(supportsSymbolExtraction('php'), true);
		assert.strictEqual(supportsSymbolExtraction('kotlin'), false);
	});

	/**
	 * The same node means different things depending on where it sits: Ruby's `def` is a function at
	 * file level and a method inside a class. Getting this wrong makes every top-level helper look
	 * like a member of nothing.
	 */
	test('a definition inside a type is a method, outside it a function', () => {
		const root = node('program', '', [
			decl('class', 'Invoice', [decl('method', 'pay')]),
			decl('method', 'helper'),
		]);
		assert.deepStrictEqual(shown(extractSymbols(root, 'ruby'), 'ruby'), ['class Invoice', 'method Invoice#pay', 'function helper']);
	});

	/**
	 * Rust's `impl Invoice` does not declare `Invoice` — the struct is declared elsewhere. Emitting it
	 * would put a second `Invoice` in the outline and a second candidate behind every jump.
	 */
	test('a Rust impl block scopes its functions without declaring the type again', () => {
		const impl = node('impl_item', '', [decl('function_item', 'pay')], { type: node('type_identifier', 'Invoice') });
		assert.deepStrictEqual(shown(extractSymbols(node('source_file', '', [impl]), 'rust'), 'rust'), ['method Invoice::pay']);
	});

	/**
	 * A Go method belongs to its receiver, not to its nesting — it sits at file level. Without this
	 * every method in a Go project would be indexed with no owner at all.
	 */
	test('a Go method belongs to its receiver', () => {
		const receiver = node('parameter_list', '', [node('parameter_declaration', '', [node('pointer_type', '', [node('type_identifier', 'Invoice')])])]);
		const method = node('method_declaration', '', [name('Pay')], { name: name('Pay'), receiver });
		assert.deepStrictEqual(shown(extractSymbols(node('source_file', '', [method]), 'go'), 'go'), ['method Invoice.Pay']);
	});

	/** A name can hide one or two levels down — the grammars disagree on how deep. */
	test('names nested inside a declarator are still found', () => {
		const goType = node('type_declaration', '', [node('type_spec', '', [name('Invoice')], { name: name('Invoice') })]);
		assert.deepStrictEqual(extractSymbols(node('source_file', '', [goType]), 'go').map(s => s.name), ['Invoice']);

		const javaField = node('field_declaration', '', [node('variable_declarator', '', [], { name: node('identifier', 'total') })]);
		assert.deepStrictEqual(extractSymbols(node('program', '', [javaField]), 'java').map(s => s.name), ['total']);

		const csField = node('field_declaration', '', [node('variable_declaration', '', [node('variable_declarator', '', [], { name: node('identifier', 'Total') })])]);
		assert.deepStrictEqual(extractSymbols(node('compilation_unit', '', [csField]), 'csharp').map(s => s.name), ['Total']);
	});

	/** Each language writes qualified names its own way, and the user reads exactly that. */
	test('qualified names use the punctuation of their own language', () => {
		const method: CodeSymbol = { name: 'pay', kind: 'method', container: ['App', 'Invoice'], startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
		assert.deepStrictEqual([
			qualifiedName(method, 'php'), qualifiedName(method, 'go'), qualifiedName(method, 'ruby'), qualifiedName(method, 'rust'),
		], ['App\\Invoice::pay', 'App.Invoice.pay', 'App::Invoice#pay', 'App::Invoice::pay']);
	});

	/** Everything a provider needs comes from the tables, so a new language is one table and no lists. */
	test('every supported language declares a grammar and extensions', () => {
		const languages = symbolLanguageIds();
		assert.ok(languages.includes('php') && languages.includes('csharp'));
		assert.strictEqual(grammarNameOf('csharp'), 'c-sharp', 'грамматика C# лежит в файле c-sharp');
		assert.strictEqual(grammarNameOf('php'), 'php');
		assert.deepStrictEqual(languages.filter(id => extensionsOf(id).length === 0), []);
	});

	/**
	 * A name inside a comment or a string is a mention, not a use of the symbol — the distinction
	 * that keeps docblocks out of «references» and out of occurrence highlighting.
	 */
	test('comments and string literals are recognised across the grammars', () => {
		const positioned = (type: string, startLine: number, startColumn: number, endLine: number, endColumn: number): SyntaxNodeLike => ({
			type, text: '', startPosition: { row: startLine, column: startColumn }, endPosition: { row: endLine, column: endColumn },
			namedChildCount: 0, namedChild: () => null, childForFieldName: () => null,
		});
		// The names differ per language; all of them must be caught by shape, not by a hand-kept list.
		const root = node('program', '', [
			positioned('comment', 1, 0, 1, 20),
			positioned('block_comment', 3, 4, 5, 6),
			positioned('encapsed_string', 7, 8, 7, 20),
			positioned('interpreted_string_literal', 9, 0, 9, 10),
			positioned('line_comment', 11, 0, 11, 8),
			decl('function_definition', 'helper'),
		]);
		const spans = nonCodeSpans(root);
		assert.strictEqual(spans.length, 5, 'объявление в список не-кода не попадает');

		assert.deepStrictEqual({
			внутриКомментария: isInsideSpans(spans, 1, 5),
			наГраницеНачала: isInsideSpans(spans, 1, 0),
			наГраницеКонца: isInsideSpans(spans, 1, 20),
			многострочный: isInsideSpans(spans, 4, 0),
			передСтрокой: isInsideSpans(spans, 7, 7),
			вСтроке: isInsideSpans(spans, 7, 9),
			вКоде: isInsideSpans(spans, 20, 0),
		}, {
			внутриКомментария: true,
			наГраницеНачала: true,
			// The end column is exclusive: the character after a comment is code again.
			наГраницеКонца: false,
			многострочный: true,
			передСтрокой: false,
			вСтроке: true,
			вКоде: false,
		});
	});
});
