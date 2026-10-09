/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What the graph canvas draws, with nothing about where the graph came from
 *
 * The docs graph and the project graph share one canvas: the physics, the zoom, the search and the click are the same,
 * Only the meaning of a node differs, and each host translates its own graph into this shape
 */

export interface IGraphViewNode {
	readonly id: string;
	readonly label: string;
	/** Nodes of one group share a colour; the host says which colour a group gets */
	readonly group: string;
	/** How large the dot is drawn; inertia comes from the node's links in the picture, not from this */
	readonly weight: number;
	/** Ringed as the thing to look at: a doc nobody can reach, a file nothing touches */
	readonly flagged?: boolean;
	/** Hover text; the id when absent */
	readonly title?: string;
}

export interface IGraphViewEdge {
	readonly from: string;
	readonly to: string;
}

export interface IGraphView {
	readonly nodes: readonly IGraphViewNode[];
	readonly edges: readonly IGraphViewEdge[];
	/** Links that lead nowhere, by the node they start from: drawn as short open stubs */
	readonly stubs?: ReadonlyMap<string, number>;
}
