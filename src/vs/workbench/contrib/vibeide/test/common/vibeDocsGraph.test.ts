/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { buildDocGraph, localGraph, parseDocLinks, stripCode } from '../../common/vibeDocsGraph.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('vibeDocsGraph — link parsing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('relative links: plain, anchored; skips urls, mdc:, bare anchors and non-md', () => {
		const md = [
			'[a](guide.md)',
			'[b](sub/other.md#section)',
			'[c](https://example.com/x.md)',
			'[d](mdc:rules/x.md)',
			'[e](#local-heading)',
			'[f](image.png)',
		].join('\n');
		assert.deepStrictEqual(parseDocLinks(md), [
			{ target: 'guide.md', kind: 'relative' },
			{ target: 'sub/other.md', kind: 'relative' },
		]);
	});

	test('wikilinks: plain, aliased, anchored', () => {
		const md = '[[plain]] and [[target|alias]] and [[target2#heading]]';
		assert.deepStrictEqual(parseDocLinks(md), [
			{ target: 'plain', kind: 'wiki' },
			{ target: 'target', kind: 'wiki' },
			{ target: 'target2', kind: 'wiki' },
		]);
	});

	test('code is prose about links, not links — fenced and inline are stripped', () => {
		const md = [
			'```',
			'[fenced](nope.md) and [[fencedWiki]]',
			'```',
			'inline `[inline](nope.md)` and `[[inlineWiki]]`',
			'[real](yes.md)',
		].join('\n');
		assert.deepStrictEqual(parseDocLinks(md), [{ target: 'yes.md', kind: 'relative' }]);
	});

	test('stripCode leaves prose intact', () => {
		assert.strictEqual(stripCode('a `b` c'), 'a  c');
	});
});

suite('vibeDocsGraph — graph building', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolves both link kinds into edges, counts degree, marks reachability', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[k](knowledge/README.md)' },
			{ id: 'knowledge/README.md', content: '[e](ui/entry.md)' },
			{ id: 'knowledge/ui/entry.md', content: 'see [[other]]' },
			{ id: 'knowledge/ui/other.md', content: 'leaf' },
			{ id: 'stranded.md', content: 'nobody links here' },
		]);

		assert.deepStrictEqual(graph.edges, [
			{ from: 'README.md', to: 'knowledge/README.md', kind: 'relative' },
			{ from: 'knowledge/README.md', to: 'knowledge/ui/entry.md', kind: 'relative' },
			{ from: 'knowledge/ui/entry.md', to: 'knowledge/ui/other.md', kind: 'wiki' },
		]);
		assert.deepStrictEqual(graph.deadLinks, []);
		assert.deepStrictEqual(
			graph.nodes.map(n => ({ id: n.id, domain: n.domain, degree: n.degree, reachable: n.reachable })),
			[
				{ id: 'README.md', domain: '', degree: 1, reachable: true },
				{ id: 'knowledge/README.md', domain: 'knowledge', degree: 2, reachable: true },
				{ id: 'knowledge/ui/entry.md', domain: 'knowledge', degree: 2, reachable: true },
				{ id: 'knowledge/ui/other.md', domain: 'knowledge', degree: 1, reachable: true },
				{ id: 'stranded.md', domain: '', degree: 0, reachable: false },
			],
		);
	});

	test('dead links: missing relative target and unresolvable wikilink', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[gone](missing.md) and [[nowhere]]' },
		]);
		assert.deepStrictEqual(graph.deadLinks, [
			{ from: 'README.md', target: 'missing.md', kind: 'relative' },
			{ from: 'README.md', target: 'nowhere', kind: 'wiki' },
		]);
		assert.deepStrictEqual(graph.edges, []);
	});

	test('ambiguous wikilink resolves to nothing rather than inventing an edge', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[[dup]]' },
			{ id: 'a/dup.md', content: '' },
			{ id: 'b/dup.md', content: '' },
		]);
		assert.deepStrictEqual(graph.edges, []);
		assert.deepStrictEqual(graph.deadLinks, [{ from: 'README.md', target: 'dup', kind: 'wiki' }]);
	});

	test('wikilink prefers an exact docs-relative path over a basename match', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[[a/dup]]' },
			{ id: 'a/dup.md', content: '' },
			{ id: 'b/dup.md', content: '' },
		]);
		assert.deepStrictEqual(graph.edges, [{ from: 'README.md', to: 'a/dup.md', kind: 'wiki' }]);
	});

	test('out of scope, not defects: specs, escaping links, templates', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[s](specs/x/PRODUCT.md) [up](../CLAUDE.md) [t](_templateEntry.md)' },
			{ id: 'specs/x/PRODUCT.md', content: 'spec' },
			{ id: '_templateEntry.md', content: '[x](../topic/file.md)' },
		]);
		assert.deepStrictEqual(graph.edges, []);
		assert.deepStrictEqual(graph.deadLinks, []);
		// specs are excluded from the node set entirely; the template stays but is never stranded.
		assert.deepStrictEqual(
			graph.nodes.map(n => ({ id: n.id, reachable: n.reachable })),
			[{ id: 'README.md', reachable: true }, { id: '_templateEntry.md', reachable: true }],
		);
	});

	test('repeated links between the same pair collapse to one edge', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[a](x.md) [again](x.md) [[x]]' },
			{ id: 'x.md', content: '' },
		]);
		assert.deepStrictEqual(graph.edges, [{ from: 'README.md', to: 'x.md', kind: 'relative' }]);
	});
});

suite('vibeDocsGraph — local graph', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('depth 1 keeps immediate neighbours in both directions', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: '[m](mid.md)' },
			{ id: 'mid.md', content: '[l](leaf.md)' },
			{ id: 'leaf.md', content: '' },
			{ id: 'far.md', content: '' },
		]);
		const local = localGraph(graph, 'mid.md', 1);
		assert.deepStrictEqual(local.nodes.map(n => n.id).sort(), ['README.md', 'leaf.md', 'mid.md']);
	});
});

suite('vibeDocsGraph — skills on the canvas', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a skill is drawn, but never lends reachability nor reports dead links', () => {
		const graph = buildDocGraph([
			{ id: 'README.md', content: 'nothing here' },
			{ id: 'ui/stranded.md', content: 'orphan' },
			{
				id: '.vibe/skills/review-pr/SKILL.md',
				content: 'см. [[stranded]] и [прочее](../../../docs/missing.md)',
				external: true,
			},
		]);
		const stranded = graph.nodes.find(n => n.id === 'ui/stranded.md')!;
		const skill = graph.nodes.find(n => n.id === '.vibe/skills/review-pr/SKILL.md')!;
		assert.deepStrictEqual(
			{
				// The gate must keep meaning what it meant: a doc nothing in docs/ links to stays
				// stranded even when a skill points at it.
				strandedStillUnreachable: stranded.reachable,
				edge: graph.edges.map(e => `${e.from}→${e.to}`),
				// Named by folder: every skill file is called SKILL.md.
				skillLabel: skill.label,
				skillDomain: skill.domain,
				skillReachable: skill.reachable,
				// A skill may legitimately point outside the indexed tree — that is not a docs defect.
				deadLinks: graph.deadLinks.length,
			},
			{
				strandedStillUnreachable: false,
				edge: ['.vibe/skills/review-pr/SKILL.md→ui/stranded.md'],
				skillLabel: 'review-pr',
				skillDomain: 'skills',
				skillReachable: true,
				deadLinks: 0,
			},
		);
	});
});
