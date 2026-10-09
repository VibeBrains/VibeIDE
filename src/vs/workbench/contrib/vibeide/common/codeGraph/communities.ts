/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Subsystems of a project: groups of files that talk to each other more than to the rest
 *
 * Leiden over modularity, deterministic: every place the paper draws at random takes the best move instead,
 * So the same repository gives the same picture on every open and the result can be tested
 * Leiden rather than Louvain for one property: Louvain can leave a community whose files do not connect at all,
 * And a subsystem drawn as one colour that falls apart into strangers is a lie the picture tells
 *
 * Pure: an undirected weighted graph in, a partition out, no paths and no I/O
 */

/** One undirected link between two nodes; parallel links add up */
export interface WeightedLink {
	readonly a: number;
	readonly b: number;
	readonly weight: number;
}

/** Above 1 favours smaller groups, below 1 larger ones; 1 is plain modularity */
const DEFAULT_RESOLUTION = 1;

/** A safety stop: real graphs converge in a handful of levels */
const MAX_LEVELS = 32;

interface Graph {
	readonly size: number;
	/** Neighbours with summed weights, self-loops kept: they carry the weight folded into an aggregated node */
	readonly adjacency: readonly ReadonlyMap<number, number>[];
	/** Weighted degree of each node, self-loops counted twice as modularity defines it */
	readonly degree: readonly number[];
	/** Sum of all degrees, twice the total edge weight */
	readonly total: number;
}

function graphOf(size: number, links: readonly WeightedLink[]): Graph {
	const adjacency = Array.from({ length: size }, () => new Map<number, number>());
	const degree = new Array<number>(size).fill(0);
	let total = 0;
	for (const { a, b, weight } of links) {
		if (weight <= 0 || a < 0 || b < 0 || a >= size || b >= size) {
			continue;
		}
		adjacency[a].set(b, (adjacency[a].get(b) ?? 0) + weight);
		if (a !== b) {
			adjacency[b].set(a, (adjacency[b].get(a) ?? 0) + weight);
		}
		degree[a] += weight;
		degree[b] += weight;
		total += 2 * weight;
	}
	return { size, adjacency, degree, total };
}

/** Weight from `node` into each community it touches, its own loop excluded */
function weightsToCommunities(graph: Graph, node: number, membership: readonly number[]): Map<number, number> {
	const out = new Map<number, number>();
	for (const [neighbour, weight] of graph.adjacency[node]) {
		if (neighbour === node) {
			continue;
		}
		const community = membership[neighbour];
		out.set(community, (out.get(community) ?? 0) + weight);
	}
	return out;
}

/**
 * Leiden's fast local moving: a queue instead of sweeps, and a node is revisited only when a neighbour left its side
 * Ties keep the node where it is, then go to the lowest community id, so the outcome does not depend on map order
 */
function moveNodes(graph: Graph, membership: number[], resolution: number): void {
	const communityDegree = new Map<number, number>();
	for (let node = 0; node < graph.size; node++) {
		communityDegree.set(membership[node], (communityDegree.get(membership[node]) ?? 0) + graph.degree[node]);
	}
	const queue: number[] = Array.from({ length: graph.size }, (_, i) => i);
	const queued = new Array<boolean>(graph.size).fill(true);
	let head = 0;
	while (head < queue.length) {
		const node = queue[head++];
		queued[node] = false;
		const own = membership[node];
		const degree = graph.degree[node];
		const towards = weightsToCommunities(graph, node, membership);
		// The node is taken out first, so staying is measured on the same footing as leaving
		communityDegree.set(own, communityDegree.get(own)! - degree);
		const gainOf = (community: number) => (towards.get(community) ?? 0) - resolution * degree * (communityDegree.get(community) ?? 0) / graph.total;
		let best = own;
		let bestGain = gainOf(own);
		for (const community of [...towards.keys()].sort((x, y) => x - y)) {
			const gain = gainOf(community);
			if (gain > bestGain + 1e-12) {
				best = community;
				bestGain = gain;
			}
		}
		communityDegree.set(best, (communityDegree.get(best) ?? 0) + degree);
		if (best === own) {
			continue;
		}
		membership[node] = best;
		for (const neighbour of graph.adjacency[node].keys()) {
			if (!queued[neighbour] && membership[neighbour] !== best) {
				queued[neighbour] = true;
				queue.push(neighbour);
			}
		}
	}
}

/**
 * Leiden's refinement: inside each community, start from singletons and merge only into parts that stay well connected
 * This is what guarantees that every community is connected; the paper picks the merge at random, we take the best one
 */
function refine(graph: Graph, membership: readonly number[], resolution: number): number[] {
	const refined = Array.from({ length: graph.size }, (_, i) => i);
	const communityDegree = new Map<number, number>();
	for (let node = 0; node < graph.size; node++) {
		communityDegree.set(membership[node], (communityDegree.get(membership[node]) ?? 0) + graph.degree[node]);
	}
	const partDegree = new Map<number, number>(graph.degree.map((degree, node) => [node, degree]));
	const partSize = new Map<number, number>(graph.degree.map((_, node) => [node, 1]));
	// Weight from a refined part to the rest of its community: the well-connectedness test reads it
	const partOutside = new Map<number, number>();
	for (let node = 0; node < graph.size; node++) {
		let outside = 0;
		for (const [neighbour, weight] of graph.adjacency[node]) {
			if (neighbour !== node && membership[neighbour] === membership[node]) {
				outside += weight;
			}
		}
		partOutside.set(node, outside);
	}
	const wellConnected = (inside: number, degree: number, community: number) =>
		inside >= resolution * degree * (communityDegree.get(community)! - degree) / graph.total;

	for (let node = 0; node < graph.size; node++) {
		const community = membership[node];
		// Only a node still alone moves, and only if it belongs in its community at all
		if (partSize.get(refined[node]) !== 1 || !wellConnected(partOutside.get(node)!, graph.degree[node], community)) {
			continue;
		}
		const towards = new Map<number, number>();
		for (const [neighbour, weight] of graph.adjacency[node]) {
			if (neighbour !== node && membership[neighbour] === community) {
				towards.set(refined[neighbour], (towards.get(refined[neighbour]) ?? 0) + weight);
			}
		}
		const degree = graph.degree[node];
		let best = refined[node];
		let bestGain = 0;
		for (const part of [...towards.keys()].sort((x, y) => x - y)) {
			if (part === refined[node] || !wellConnected(partOutside.get(part)!, partDegree.get(part)!, community)) {
				continue;
			}
			const gain = towards.get(part)! - resolution * degree * partDegree.get(part)! / graph.total;
			if (gain > bestGain + 1e-12) {
				best = part;
				bestGain = gain;
			}
		}
		if (best === refined[node]) {
			continue;
		}
		const from = refined[node];
		refined[node] = best;
		partDegree.set(best, partDegree.get(best)! + degree);
		partSize.set(best, partSize.get(best)! + 1);
		partSize.set(from, 0);
		// Links between the node and the part become internal; its other links inside the community join the part's outside
		const between = towards.get(best)!;
		partOutside.set(best, partOutside.get(best)! - between + (partOutside.get(node)! - between));
	}
	return refined;
}

/** Renumbers ids densely in order of first appearance, so the result does not carry internal numbering */
function compact(ids: readonly number[]): number[] {
	const renumber = new Map<number, number>();
	return ids.map(id => {
		if (!renumber.has(id)) {
			renumber.set(id, renumber.size);
		}
		return renumber.get(id)!;
	});
}

/**
 * Splits `size` nodes into communities by Leiden over modularity
 *
 * Returns the community of each node, numbered from 0 by size, the largest first, ties by first node:
 * Colour and order then follow importance, and the numbering is stable for the same input
 */
export function detectCommunities(size: number, links: readonly WeightedLink[], resolution: number = DEFAULT_RESOLUTION): number[] {
	if (size === 0) {
		return [];
	}
	let graph = graphOf(size, links);
	if (graph.total === 0) {
		return Array.from({ length: size }, (_, i) => i);
	}
	// Each original node's position in the current, possibly aggregated, graph
	let nodeOf = Array.from({ length: size }, (_, i) => i);
	let membership = Array.from({ length: graph.size }, (_, i) => i);

	for (let level = 0; level < MAX_LEVELS; level++) {
		moveNodes(graph, membership, resolution);
		membership = compact(membership);
		// Every community is one node: nothing coarser is left to find
		if (new Set(membership).size === graph.size) {
			break;
		}
		const refined = compact(refine(graph, membership, resolution));
		const partCount = new Set(refined).size;
		// Refinement merged nothing, so aggregating would give the same graph back and loop
		if (partCount === graph.size) {
			break;
		}
		// The aggregate graph has one node per refined part; it starts in the community its part came from
		const communityOfPart = new Array<number>(partCount);
		for (let node = 0; node < graph.size; node++) {
			communityOfPart[refined[node]] = membership[node];
		}
		const aggregateLinks: WeightedLink[] = [];
		for (let node = 0; node < graph.size; node++) {
			for (const [neighbour, weight] of graph.adjacency[node]) {
				// Each undirected link is seen from both ends; keep one, and loops once
				if (neighbour < node) {
					continue;
				}
				aggregateLinks.push({ a: refined[node], b: refined[neighbour], weight });
			}
		}
		nodeOf = nodeOf.map(position => refined[position]);
		graph = graphOf(partCount, aggregateLinks);
		membership = communityOfPart;
	}

	const raw = nodeOf.map(position => membership[position]);
	return rankBySize(raw);
}

/** Community ids from 0, the largest first; equal sizes keep the order of their first node */
function rankBySize(raw: readonly number[]): number[] {
	const sizes = new Map<number, number>();
	const first = new Map<number, number>();
	raw.forEach((community, node) => {
		sizes.set(community, (sizes.get(community) ?? 0) + 1);
		if (!first.has(community)) {
			first.set(community, node);
		}
	});
	const order = [...sizes.keys()].sort((x, y) => sizes.get(y)! - sizes.get(x)! || first.get(x)! - first.get(y)!);
	const rank = new Map(order.map((community, index) => [community, index]));
	return raw.map(community => rank.get(community)!);
}

/** Modularity of a partition; the test measures that the detection improves on trivial splits */
export function modularity(size: number, links: readonly WeightedLink[], membership: readonly number[], resolution: number = DEFAULT_RESOLUTION): number {
	const graph = graphOf(size, links);
	if (graph.total === 0) {
		return 0;
	}
	const inside = new Map<number, number>();
	const degree = new Map<number, number>();
	for (let node = 0; node < size; node++) {
		const community = membership[node];
		degree.set(community, (degree.get(community) ?? 0) + graph.degree[node]);
		for (const [neighbour, weight] of graph.adjacency[node]) {
			if (membership[neighbour] === community) {
				// A loop is stored once and counts twice; any other link is met from both ends
				inside.set(community, (inside.get(community) ?? 0) + (neighbour === node ? 2 * weight : weight));
			}
		}
	}
	let q = 0;
	for (const [community, sum] of degree) {
		q += (inside.get(community) ?? 0) / graph.total - resolution * (sum / graph.total) ** 2;
	}
	return q;
}
