/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	buildCodeGraph,
	CodeGraphFileInput,
	fileNodeId,
	neighbors,
	noteNodeId,
	parseWhyNotes,
	pathBetween,
	resolveImportTarget,
	scopedSubgraph,
	symbolNodeId,
} from '../../../common/codeGraph/vibeCodeGraph.js';

suite('Code graph — pure core', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const known = (...paths: string[]) => new Set(paths);

	suite('resolveImportTarget', () => {
		test('provenance ladder: verbatim hit, single completion, several completions', () => {
			const files = known('/repo/a.ts', '/repo/lib/util.ts', '/repo/lib/util.js', '/repo/pkg/index.ts', '/repo/exact.ts');
			assert.deepStrictEqual(
				[
					resolveImportTarget('/repo/a.ts', './exact.ts', files),   // names the file as it is
					resolveImportTarget('/repo/a.ts', './pkg', files),        // completed to an index file
					resolveImportTarget('/repo/a.ts', './lib/util', files),   // .ts and .js both exist
				],
				[
					{ path: '/repo/exact.ts', provenance: 'extracted' },
					{ path: '/repo/pkg/index.ts', provenance: 'inferred' },
					{ path: '/repo/lib/util.js', provenance: 'ambiguous' },   // first in sorted order, deterministically
				],
			);
		});

		test('bare packages and unknown paths produce no edge at all', () => {
			const files = known('/repo/a.ts');
			assert.deepStrictEqual(
				[
					resolveImportTarget('/repo/a.ts', 'react', files),
					resolveImportTarget('/repo/a.ts', '@scope/pkg', files),
					resolveImportTarget('/repo/a.ts', './missing', files),
				],
				[undefined, undefined, undefined],
			);
		});

		test('walks up out of nested directories', () => {
			const files = known('/repo/src/deep/here.ts', '/repo/src/shared.ts');
			assert.deepStrictEqual(
				resolveImportTarget('/repo/src/deep/here.ts', '../shared', files),
				{ path: '/repo/src/shared.ts', provenance: 'inferred' },
			);
		});
	});

	suite('parseWhyNotes', () => {
		test('picks markers out of comments and leaves prose and string literals alone', () => {
			const content = [
				'// WHY: the vendor returns 200 on failure',      // 1
				'const a = 1; // HACK: works around #123 */',      // 2
				'# TODO: python-style comment',                    // 3
				' * FIXME: inside a block comment',                // 4
				'const label = "TODO: not a note";',               // 5 — no comment opener before the marker
				'// just a comment',                               // 6
				'// NOTE:   ',                                     // 7 — empty text
			].join('\n');
			assert.deepStrictEqual(
				parseWhyNotes(content),
				[
					{ line: 1, marker: 'WHY', text: 'the vendor returns 200 on failure' },
					{ line: 2, marker: 'HACK', text: 'works around #123' },
					{ line: 3, marker: 'TODO', text: 'python-style comment' },
					{ line: 4, marker: 'FIXME', text: 'inside a block comment' },
				],
			);
		});
	});

	suite('buildCodeGraph', () => {
		const files: CodeGraphFileInput[] = [
			{
				path: '/repo/a.ts',
				symbols: [{ name: 'doWork', startLine: 10, endLine: 20 }, { name: 'Helper', startLine: 30, endLine: 40 }],
				importSpecifiers: ['./b', 'react'],
				notes: [
					{ line: 12, marker: 'WHY', text: 'retry once, the API is flaky' },  // inside doWork
					{ line: 2, marker: 'NOTE', text: 'file-level remark' },              // outside every symbol
				],
			},
			{ path: '/repo/b.ts', symbols: [{ name: 'helperOfB' }] },
		];

		test('nodes and edges carry provenance, notes attach to the enclosing symbol', () => {
			const graph = buildCodeGraph(files);
			assert.deepStrictEqual(
				{
					nodes: graph.nodes.map(node => [node.kind, node.id]),
					edges: graph.edges.map(edge => [edge.kind, edge.provenance, edge.from, edge.to]),
				},
				{
					nodes: [
						['file', fileNodeId('/repo/a.ts')],
						['symbol', symbolNodeId('/repo/a.ts', 'doWork')],
						['symbol', symbolNodeId('/repo/a.ts', 'Helper')],
						['note', noteNodeId('/repo/a.ts', 12)],
						['note', noteNodeId('/repo/a.ts', 2)],
						['file', fileNodeId('/repo/b.ts')],
						['symbol', symbolNodeId('/repo/b.ts', 'helperOfB')],
					],
					edges: [
						['defines', 'extracted', fileNodeId('/repo/a.ts'), symbolNodeId('/repo/a.ts', 'doWork')],
						['defines', 'extracted', fileNodeId('/repo/a.ts'), symbolNodeId('/repo/a.ts', 'Helper')],
						// './b' needed an extension to resolve → inferred, not extracted; 'react' produced nothing.
						['imports', 'inferred', fileNodeId('/repo/a.ts'), fileNodeId('/repo/b.ts')],
						// Line 12 sits inside doWork's range → the attachment is a fact.
						['explains', 'extracted', noteNodeId('/repo/a.ts', 12), symbolNodeId('/repo/a.ts', 'doWork')],
						// Line 2 belongs to no symbol → falls back to the file, and says so.
						['explains', 'inferred', noteNodeId('/repo/a.ts', 2), fileNodeId('/repo/a.ts')],
						['defines', 'extracted', fileNodeId('/repo/b.ts'), symbolNodeId('/repo/b.ts', 'helperOfB')],
					],
				},
			);
		});

		test('no call edges are invented', () => {
			assert.deepStrictEqual(buildCodeGraph(files).edges.filter(edge => edge.kind === 'calls'), []);
		});
	});

	suite('queries', () => {
		const graph = buildCodeGraph([
			{ path: '/repo/a.ts', symbols: [{ name: 'A' }], importSpecifiers: ['./b.ts'] },
			{ path: '/repo/b.ts', symbols: [{ name: 'B' }], importSpecifiers: ['./c.ts'] },
			{ path: '/repo/c.ts', symbols: [{ name: 'C' }] },
			{ path: '/repo/lonely.ts' },
		]);

		test('neighbors report both directions with the edge that got there', () => {
			const result = neighbors(graph, fileNodeId('/repo/b.ts'));
			assert.deepStrictEqual(
				{
					out: result?.outgoing.map(entry => [entry.edge.kind, entry.node.id]),
					in: result?.incoming.map(entry => [entry.edge.kind, entry.node.id]),
				},
				{
					out: [['defines', symbolNodeId('/repo/b.ts', 'B')], ['imports', fileNodeId('/repo/c.ts')]],
					in: [['imports', fileNodeId('/repo/a.ts')]],
				},
			);
		});

		test('pathBetween traces across files and symbols, and reports absence honestly', () => {
			assert.deepStrictEqual(
				[
					pathBetween(graph, symbolNodeId('/repo/a.ts', 'A'), symbolNodeId('/repo/c.ts', 'C')),
					pathBetween(graph, fileNodeId('/repo/a.ts'), fileNodeId('/repo/lonely.ts')),
					pathBetween(graph, fileNodeId('/repo/a.ts'), fileNodeId('/repo/c.ts'), 1),
					pathBetween(graph, fileNodeId('/repo/a.ts'), 'file:/repo/nope.ts'),
				],
				[
					[symbolNodeId('/repo/a.ts', 'A'), fileNodeId('/repo/a.ts'), fileNodeId('/repo/b.ts'), fileNodeId('/repo/c.ts'), symbolNodeId('/repo/c.ts', 'C')],
					undefined, // nothing links the lonely file
					undefined, // two hops away, asked for one
					undefined, // unknown node
				],
			);
		});

		test('scopedSubgraph keeps only whole edges', () => {
			const scoped = scopedSubgraph(graph, [fileNodeId('/repo/b.ts')], 1);
			assert.deepStrictEqual(
				{
					nodes: scoped.nodes.map(node => node.id).sort(),
					edges: scoped.edges.map(edge => `${edge.from} -${edge.kind}-> ${edge.to}`).sort(),
				},
				{
					nodes: [fileNodeId('/repo/a.ts'), fileNodeId('/repo/b.ts'), fileNodeId('/repo/c.ts'), symbolNodeId('/repo/b.ts', 'B')].sort(),
					edges: [
						`${fileNodeId('/repo/a.ts')} -imports-> ${fileNodeId('/repo/b.ts')}`,
						`${fileNodeId('/repo/b.ts')} -defines-> ${symbolNodeId('/repo/b.ts', 'B')}`,
						`${fileNodeId('/repo/b.ts')} -imports-> ${fileNodeId('/repo/c.ts')}`,
					].sort(),
				},
			);
		});
	});
});
