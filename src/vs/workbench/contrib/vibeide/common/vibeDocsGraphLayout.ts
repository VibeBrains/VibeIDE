/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Force-directed layout for the docs graph. Pure: positions in, positions out, no DOM and no
 * timers — the canvas owns the animation loop and calls {@link stepLayout} once per frame.
 *
 * Repulsion is the naive O(n²) pass rather than Barnes-Hut: the docs tree is ~200 nodes, which is
 * ~20k pairs per tick and comfortably inside a frame. Revisit only if the corpus grows an order
 * of magnitude.
 */

import { IDocGraphEdge } from './vibeDocsGraph.js';

export interface ILayoutNode {
	readonly id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	/** Inbound + outbound links; heavier nodes drift less. */
	readonly degree: number;
	/** Pinned by the user's cursor — the simulation must not move it. */
	pinned: boolean;
}

export interface ILayoutOptions {
	readonly repulsion: number;
	readonly springLength: number;
	readonly springStrength: number;
	readonly gravity: number;
	readonly damping: number;
}

export const DEFAULT_LAYOUT_OPTIONS: ILayoutOptions = {
	repulsion: 9000,
	springLength: 70,
	springStrength: 0.02,
	gravity: 0.012,
	damping: 0.82,
};

/** Below this total kinetic energy the graph is visually still and the loop can stop. */
export const LAYOUT_SETTLED_ENERGY = 0.28;

/**
 * Deterministic ring seeding. `Math.random` would make every open a different picture and make
 * the layout untestable; a golden-angle spiral spreads nodes evenly and repeats exactly.
 */
export function seedPositions(ids: readonly string[], degrees: ReadonlyMap<string, number>): ILayoutNode[] {
	const golden = Math.PI * (3 - Math.sqrt(5));
	return ids.map((id, i) => {
		const radius = 24 * Math.sqrt(i + 1);
		const angle = i * golden;
		return {
			id,
			x: Math.cos(angle) * radius,
			y: Math.sin(angle) * radius,
			vx: 0,
			vy: 0,
			degree: degrees.get(id) ?? 0,
			pinned: false,
		};
	});
}

/** Heavier, better-connected docs should anchor the picture instead of being flung about. */
function massOf(node: ILayoutNode): number {
	return 1 + node.degree * 0.5;
}

/**
 * Advances the simulation one tick and returns the total kinetic energy, which the caller uses to
 * decide when the graph has settled.
 */
export function stepLayout(
	nodes: readonly ILayoutNode[],
	edges: readonly IDocGraphEdge[],
	options: ILayoutOptions = DEFAULT_LAYOUT_OPTIONS,
): number {
	const index = new Map<string, ILayoutNode>(nodes.map(n => [n.id, n]));

	for (const node of nodes) {
		node.vx *= options.damping;
		node.vy *= options.damping;
	}

	// Repulsion — every pair pushes apart, which is what opens the clusters up.
	for (let i = 0; i < nodes.length; i++) {
		const a = nodes[i];
		for (let j = i + 1; j < nodes.length; j++) {
			const b = nodes[j];
			let dx = a.x - b.x;
			let dy = a.y - b.y;
			let distSq = dx * dx + dy * dy;
			if (distSq < 0.01) {
				// Exactly coincident nodes have no direction to separate along; nudge them apart
				// deterministically by index so the frame can't produce NaN.
				dx = (i - j) * 0.01 || 0.01;
				dy = 0.01;
				distSq = dx * dx + dy * dy;
			}
			const dist = Math.sqrt(distSq);
			const force = options.repulsion / distSq;
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			const ma = massOf(a);
			const mb = massOf(b);
			a.vx += fx / ma;
			a.vy += fy / ma;
			b.vx -= fx / mb;
			b.vy -= fy / mb;
		}
	}

	// Springs — linked docs pull together.
	for (const edge of edges) {
		const a = index.get(edge.from);
		const b = index.get(edge.to);
		if (!a || !b) {
			continue;
		}
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
		const force = (dist - options.springLength) * options.springStrength;
		const fx = (dx / dist) * force;
		const fy = (dy / dist) * force;
		const ma = massOf(a);
		const mb = massOf(b);
		a.vx += fx / ma;
		a.vy += fy / ma;
		b.vx -= fx / mb;
		b.vy -= fy / mb;
	}

	// Gravity — without it disconnected islands drift off to infinity.
	for (const node of nodes) {
		node.vx -= node.x * options.gravity;
		node.vy -= node.y * options.gravity;
	}

	let energy = 0;
	for (const node of nodes) {
		if (node.pinned) {
			node.vx = 0;
			node.vy = 0;
			continue;
		}
		node.x += node.vx;
		node.y += node.vy;
		energy += node.vx * node.vx + node.vy * node.vy;
	}
	return energy;
}
