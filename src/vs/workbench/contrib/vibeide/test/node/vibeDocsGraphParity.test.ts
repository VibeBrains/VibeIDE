/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pins the duplicated link parser.
 *
 * `scripts/vibe-docs-graph.mjs` gates CI and must stay dependency-free — it runs without `npm ci`,
 * so it cannot import `common/vibeDocsGraph.ts`. Both therefore carry their own copy of the rules,
 * and a copy nobody checks drifts. This compares the two by BEHAVIOUR over a corpus of the cases
 * that actually bite (code fences, aliases, `mdc:`, anchors), so a rule changed on one side without
 * the other fails here rather than silently making the graph disagree with the gate.
 */

import * as assert from 'assert';
import { fileURLToPath, pathToFileURL } from 'url';
// eslint-disable-next-line local/code-import-patterns -- node 'path' in a node test (by design)
import { join } from 'path';
import { parseDocLinks as parseInModel } from '../../common/vibeDocsGraph.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

interface IRawLink { readonly target: string; readonly kind: string }
type ParseFn = (content: string) => IRawLink[];

/** Tests execute from `out/`; the script lives in the repo, above whichever root we run from. */
function repoRootOf(fileUrl: string): string {
	const file = fileURLToPath(fileUrl);
	const marker = file.search(/[/\\](out|src)[/\\]/);
	assert.ok(marker > 0, `cannot locate repo root from ${file}`);
	return file.slice(0, marker);
}

const CORPUS: readonly { readonly name: string; readonly md: string }[] = [
	{ name: 'plain relative link', md: '[a](guide.md)' },
	{ name: 'anchored relative link', md: '[a](sub/other.md#section)' },
	{ name: 'http url is not a doc link', md: '[a](https://example.com/x.md)' },
	{ name: 'mdc: link resolves elsewhere at runtime', md: '[a](mdc:rules/x.md)' },
	{ name: 'bare anchor is not a doc link', md: '[a](#heading)' },
	{ name: 'non-markdown target', md: '[a](picture.png)' },
	{ name: 'plain wikilink', md: 'see [[entry]]' },
	{ name: 'aliased wikilink', md: 'see [[entry|Nice Name]]' },
	{ name: 'anchored wikilink', md: 'see [[entry#Heading]]' },
	{ name: 'wikilink with explicit extension', md: 'see [[ui/entry.md]]' },
	{ name: 'fenced code is prose about links', md: '```\n[a](nope.md)\n[[nopeWiki]]\n```\n[b](yes.md)' },
	{ name: 'inline code is prose about links', md: 'use `[a](nope.md)` and `[[nopeWiki]]` here' },
	{ name: 'array literal is not a wikilink', md: "const pairs = [['a','A'],['b','B']];" },
	{ name: 'mixed line', md: '[a](x.md) then [[y]] then [z](https://q) then [[w|alias]]' },
	{ name: 'nothing at all', md: '# Heading\n\nJust prose.' },
];

suite('vibeDocsGraph — parity with scripts/vibe-docs-graph.mjs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let parseInScript: ParseFn;

	suiteSetup(async () => {
		const scriptPath = join(repoRootOf(import.meta.url), 'scripts', 'vibe-docs-graph.mjs');
		const script = await import(pathToFileURL(scriptPath).href);
		parseInScript = script.parseDocLinks;
		assert.strictEqual(typeof parseInScript, 'function', 'script must export parseDocLinks');
	});

	test('both parsers agree on every corpus case', () => {
		const disagreements: string[] = [];
		for (const { name, md } of CORPUS) {
			const fromModel = JSON.stringify(parseInModel(md));
			const fromScript = JSON.stringify(parseInScript(md));
			if (fromModel !== fromScript) {
				disagreements.push(`${name}\n    model:  ${fromModel}\n    script: ${fromScript}`);
			}
		}
		assert.deepStrictEqual(disagreements, []);
	});
});
