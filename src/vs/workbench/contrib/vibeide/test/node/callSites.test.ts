/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Calls read from REAL grammars, not from hand-made trees: a node type or a field name guessed wrong reads nothing,
 * And a fake tree written from the same guess would pass anyway
 * The grammars are the .wasm files the editor ships (`@vscode/tree-sitter-wasm`), loaded through `fs`, hence `test/node/`
 */

import * as assert from 'assert';
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns -- node 'path' in a node test (by design)
import { dirname, join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { callGrammarOf, extractCalls, FileCalls } from '../../common/codeSymbols/callSites.js';
import { SyntaxNodeLike } from '../../common/codeSymbols/treeSitterSymbols.js';

interface TreeSitterModule {
	readonly Parser: { init(options: { locateFile: () => string }): Promise<void>; new(): { setLanguage(language: unknown): void; parse(text: string): { rootNode: unknown; delete(): void } | null; delete(): void } };
	readonly Language: { load(path: string): Promise<unknown> };
}

const require = createRequire(import.meta.url);
const treeSitter = require('@vscode/tree-sitter-wasm') as TreeSitterModule;
const WASM_DIR = dirname(require.resolve('@vscode/tree-sitter-wasm'));

let initialized: Promise<void> | undefined;

async function parse(languageId: string, text: string): Promise<FileCalls> {
	initialized ??= treeSitter.Parser.init({ locateFile: () => join(WASM_DIR, 'tree-sitter.wasm') });
	await initialized;
	const language = await treeSitter.Language.load(join(WASM_DIR, `tree-sitter-${callGrammarOf(languageId)}.wasm`));
	const parser = new treeSitter.Parser();
	parser.setLanguage(language);
	const tree = parser.parse(text)!;
	try {
		return extractCalls(tree.rootNode as SyntaxNodeLike, languageId);
	} finally {
		tree.delete();
		parser.delete();
	}
}

const show = (file: FileCalls) => ({
	calls: file.calls.map(call => call.receiver ? `${call.receiver}.${call.callee}` : call.callee),
	imports: file.imports.map(binding => `${binding.local}=${binding.imported}@${binding.specifier}`),
	declared: [...file.declared].sort(),
});

suite('call sites from real grammars', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('TypeScript: calls, members, constructors, every kind of import, and what the file declares', async () => {
		const file = await parse('typescript', [
			`import { save, load as fetch } from './repo.js';`,
			`import * as util from '../util';`,
			`import Store from './store';`,
			`export function run() { save(); fetch(1); util.clamp(); Store.open(); this.tick(); a().b(); new Queue<string>(); }`,
			`class Worker { step() { run(); } }`,
			`const helper = () => run();`,
			`const value = 42;`,
		].join('\n'));
		assert.deepStrictEqual(show(file), {
			calls: ['save', 'fetch', 'util.clamp', 'Store.open', 'tick', 'b', 'a', 'Queue', 'run', 'run'],
			imports: ['save=save@./repo.js', 'fetch=load@./repo.js', 'util=*@../util', 'Store=default@./store'],
			declared: ['Worker', 'helper', 'run', 'step'],
		});
	});

	test('the other seven languages: plain calls, calls on a receiver, constructors', async () => {
		const samples: ReadonlyArray<readonly [string, string]> = [
			['php', '<?php function f() { g(); $o->m(); A::s(); new \\App\\B(); }'],
			['python', 'def f():\n    g()\n    o.m()\n'],
			['go', 'package p\nfunc f() { g(); o.M() }'],
			['ruby', 'def f\n  g()\n  o.m\nend'],
			['rust', 'fn f() { g(); o.m(); A::s(); }'],
			['java', 'class A { void f() { g(); o.m(); new B(); } }'],
			['csharp', 'class A { void F() { G(); o.M(); new B(); } }'],
		];
		const results: Record<string, string[]> = {};
		for (const [languageId, text] of samples) {
			results[languageId] = show(await parse(languageId, text)).calls;
		}
		assert.deepStrictEqual(results, {
			php: ['g', '$o.m', 'A.s', 'B'],
			python: ['g', 'o.m'],
			go: ['g', 'o.M'],
			ruby: ['g', 'o.m'],
			rust: ['g', 'o.m', 'A.s'],
			java: ['g', 'o.m', 'B'],
			csharp: ['G', 'o.M', 'B'],
		});
	});
});
