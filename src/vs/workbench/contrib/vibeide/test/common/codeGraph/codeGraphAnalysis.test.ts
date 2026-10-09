/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { analyzeCodeGraph, ALL_LINKS_FILTER, overviewView, renderReport, subsystemNodeId, subsystemView } from '../../../common/codeGraph/codeGraphAnalysis.js';
import { detectCommunities, modularity, WeightedLink } from '../../../common/codeGraph/communities.js';
import { buildCodeGraph } from '../../../common/codeGraph/vibeCodeGraph.js';

/** Every pair of the given nodes linked once */
function clique(nodes: readonly number[]): WeightedLink[] {
	const links: WeightedLink[] = [];
	for (let i = 0; i < nodes.length; i++) {
		for (let j = i + 1; j < nodes.length; j++) {
			links.push({ a: nodes[i], b: nodes[j], weight: 1 });
		}
	}
	return links;
}

/** A repeatable pseudo-random graph: Math.random would make a failure impossible to replay */
function seededGraph(size: number, linkCount: number): WeightedLink[] {
	let state = 7;
	const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
	const links: WeightedLink[] = [];
	for (let i = 0; i < linkCount; i++) {
		// Locality makes groups to find: most links stay near their start
		const a = Math.floor(next() * size);
		const b = next() < 0.85 ? Math.min(size - 1, a + 1 + Math.floor(next() * 4)) : Math.floor(next() * size);
		links.push({ a, b, weight: 1 });
	}
	return links;
}

function isConnected(members: readonly number[], links: readonly WeightedLink[]): boolean {
	const inside = new Set(members);
	const seen = new Set([members[0]]);
	const queue = [members[0]];
	while (queue.length > 0) {
		const node = queue.pop()!;
		for (const { a, b } of links) {
			const other = a === node ? b : b === node ? a : undefined;
			if (other !== undefined && inside.has(other) && !seen.has(other)) {
				seen.add(other);
				queue.push(other);
			}
		}
	}
	return seen.size === inside.size;
}

suite('code graph — subsystems by Leiden', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('two dense groups joined by one link split there; lone nodes stay alone; the result repeats', () => {
		const links = [...clique([0, 1, 2, 3]), ...clique([4, 5, 6, 7]), { a: 3, b: 4, weight: 1 }];
		const partition = detectCommunities(10, links);
		const together = new Array(10).fill(0);
		assert.deepStrictEqual({
			partition,
			again: detectCommunities(10, links),
			betterThanOneGroup: modularity(10, links, partition) > modularity(10, links, together),
		}, {
			partition: [0, 0, 0, 0, 1, 1, 1, 1, 2, 3],
			again: [0, 0, 0, 0, 1, 1, 1, 1, 2, 3],
			betterThanOneGroup: true,
		});
	});

	test('every community found is connected — the property Leiden adds over Louvain', () => {
		const size = 300;
		const links = seededGraph(size, 900);
		const partition = detectCommunities(size, links);
		const groups = new Map<number, number[]>();
		partition.forEach((community, node) => groups.set(community, [...(groups.get(community) ?? []), node]));
		const disconnected = [...groups.values()].filter(members => !isConnected(members, links)).length;
		assert.deepStrictEqual(
			{ disconnected, positive: modularity(size, links, partition) > 0.3, groups: groups.size > 3 },
			{ disconnected: 0, positive: true, groups: true },
		);
	});
});

suite('code graph — analysis and report', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const graph = buildCodeGraph([
		{ path: '/p/src/ui/panel.ts', importSpecifiers: ['./view.ts', './theme.ts'] },
		{ path: '/p/src/ui/view.ts', importSpecifiers: ['./theme.ts'] },
		{ path: '/p/src/ui/theme.ts', importSpecifiers: [] },
		{ path: '/p/src/net/client.ts', importSpecifiers: ['./retry.ts', './http'] },
		{ path: '/p/src/net/retry.ts', importSpecifiers: ['./http.ts'] },
		{ path: '/p/src/net/http.ts', importSpecifiers: ['../ui/theme.ts'] },
		{ path: '/p/src/lonely.ts', importSpecifiers: [] },
	]);

	test('subsystems, hubs, the only bridge and the lonely file', () => {
		const analysis = analyzeCodeGraph(graph);
		assert.deepStrictEqual({
			root: analysis.root,
			subsystems: analysis.subsystems.map(s => `${s.label}: ${s.files.map(f => f.slice('/p/src/'.length)).join(', ')}`),
			hubs: analysis.report.hubs.slice(0, 2).map(h => `${h.file.slice('/p/src/'.length)} ${h.degree}`),
			surprising: analysis.report.surprising.map(s => `${s.link.from.slice('/p/src/'.length)} -> ${s.link.to.slice('/p/src/'.length)} (${s.bridgeCount}, ${s.crossesFolders})`),
			isolated: analysis.report.isolated,
			provenance: analysis.report.provenance,
		}, {
			root: '/p/src',
			subsystems: ['net: net/http.ts, net/client.ts, net/retry.ts', 'ui: ui/theme.ts, ui/panel.ts, ui/view.ts'],
			hubs: ['net/http.ts 3', 'ui/theme.ts 3'],
			surprising: ['net/http.ts -> ui/theme.ts (1, true)'],
			isolated: ['/p/src/lonely.ts'],
			provenance: { extracted: 6, inferred: 1, ambiguous: 0 },
		});
	});

	test('views: the overview joins subsystems, a subsystem shows its files and where it leads, facts only drop guesses', () => {
		const analysis = analyzeCodeGraph(graph);
		const net = analysis.subsystems.find(s => s.label === 'net')!.id;
		const ui = analysis.subsystems.find(s => s.label === 'ui')!.id;
		const overview = overviewView(analysis, ALL_LINKS_FILTER);
		const inside = subsystemView(analysis, net, ALL_LINKS_FILTER);
		const facts = subsystemView(analysis, net, { kinds: ALL_LINKS_FILTER.kinds, factsOnly: true });
		assert.deepStrictEqual({
			overview: overview.edges.length,
			nodes: inside.nodes.map(n => n.id.replace('/p/src/', '')),
			edges: inside.edges.length,
			factEdges: facts.edges.length,
			neighbourIsUi: inside.nodes.some(n => n.id === subsystemNodeId(ui)),
		}, {
			overview: 1,
			nodes: ['net/http.ts', 'net/client.ts', 'net/retry.ts', subsystemNodeId(ui)],
			edges: 4,
			factEdges: 3,
			neighbourIsUi: true,
		});
	});

	test('the agent report names the same facts', () => {
		const text = renderReport(analyzeCodeGraph(graph));
		assert.deepStrictEqual(
			['Subsystems (2', '- ui: 3 files, hub ui/theme.ts', 'net/http.ts --imports (extracted)--> ui/theme.ts: the only link between net and ui', 'Isolated files (no known links in or out): 1'].map(part => text.includes(part)),
			[true, true, true, true],
		);
	});
});
