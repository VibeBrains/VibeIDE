/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The project graph as a person reads it: subsystems, the files everything flows through, the links nobody expects
 *
 * The code graph answers an agent's narrow questions; this answers «как устроен проект» for a human and an agent alike
 * Everything here is computed from the graph alone, without a model: the labels come from paths and degrees,
 * So the same repository gives the same report on every open
 *
 * Pure: a code graph in, an analysis and canvas views out
 */

import { IGraphView, IGraphViewEdge, IGraphViewNode } from '../graphView.js';
import { detectCommunities, WeightedLink } from './communities.js';
import { CodeEdgeKind, CodeGraph, EdgeProvenance } from './vibeCodeGraph.js';

/** Kinds of link between two files; `defines` and `explains` stay inside one file and are not links between files */
export type FileLinkKind = Extract<CodeEdgeKind, 'imports' | 'extends' | 'calls'>;

const FILE_LINK_KINDS: readonly FileLinkKind[] = ['imports', 'extends', 'calls'];

export interface FileLink {
	readonly from: string;
	readonly to: string;
	readonly kind: FileLinkKind;
	readonly provenance: EdgeProvenance;
}

export interface Subsystem {
	readonly id: number;
	/** Common folder of its files, relative to the project; the hub file's name when they share none */
	readonly label: string;
	/** Most connected first */
	readonly files: readonly string[];
	readonly hub: string;
	/** Links between its own files */
	readonly internalLinks: number;
}

export interface HubFile {
	readonly file: string;
	readonly degree: number;
	readonly subsystem: number;
}

export interface SurprisingLink {
	readonly link: FileLink;
	readonly fromSubsystem: number;
	readonly toSubsystem: number;
	/** How many links join these two subsystems at all: one means this is the only bridge */
	readonly bridgeCount: number;
	/** The two files live under different top-level folders of the project */
	readonly crossesFolders: boolean;
}

export interface CodeGraphReport {
	readonly fileCount: number;
	readonly linkCount: number;
	readonly provenance: Readonly<Record<EdgeProvenance, number>>;
	readonly hubs: readonly HubFile[];
	readonly surprising: readonly SurprisingLink[];
	/** Files nothing imports and that import nothing known */
	readonly isolated: readonly string[];
}

export interface CodeGraphAnalysis {
	/** Common folder of every file; labels and relative paths are measured from it */
	readonly root: string;
	readonly links: readonly FileLink[];
	readonly communityOf: ReadonlyMap<string, number>;
	readonly degreeOf: ReadonlyMap<string, number>;
	/** Groups of two files or more, largest first; a lone file is not a subsystem and goes to `isolated` */
	readonly subsystems: readonly Subsystem[];
	readonly report: CodeGraphReport;
}

/** Which links a view shows; communities are always computed on all of them, so colours do not jump under a filter */
export interface CodeGraphViewFilter {
	readonly kinds: ReadonlySet<FileLinkKind>;
	/** Only links read from the source, without the resolver's guesses */
	readonly factsOnly: boolean;
}

export const ALL_LINKS_FILTER: CodeGraphViewFilter = { kinds: new Set(FILE_LINK_KINDS), factsOnly: false };

const REPORT_HUBS = 10;
const REPORT_SURPRISING = 10;
/** A subsystem view draws its most connected files up to this many: the layout pairs every node with every other */
export const SUBSYSTEM_VIEW_LIMIT = 400;

const SUBSYSTEM_NODE_PREFIX = 'subsystem:';

export function subsystemNodeId(id: number): string {
	return `${SUBSYSTEM_NODE_PREFIX}${id}`;
}

/** The subsystem a canvas node stands for, or undefined for a file node */
export function subsystemOfNodeId(nodeId: string): number | undefined {
	return nodeId.startsWith(SUBSYSTEM_NODE_PREFIX) ? Number(nodeId.slice(SUBSYSTEM_NODE_PREFIX.length)) : undefined;
}

/**
 * Links between files: imports as they are, inheritance and calls lifted from symbols to the files that declare them
 * A link inside one file is not a link between files and is dropped
 */
export function fileLinksOf(graph: CodeGraph): FileLink[] {
	const fileOf = new Map(graph.nodes.map(node => [node.id, node.file]));
	const links: FileLink[] = [];
	for (const edge of graph.edges) {
		if (!(FILE_LINK_KINDS as readonly string[]).includes(edge.kind)) {
			continue;
		}
		const from = fileOf.get(edge.from);
		const to = fileOf.get(edge.to);
		if (from === undefined || to === undefined || from === to) {
			continue;
		}
		links.push({ from, to, kind: edge.kind as FileLinkKind, provenance: edge.provenance });
	}
	return links;
}

function commonFolder(paths: readonly string[]): string {
	if (paths.length === 0) {
		return '';
	}
	let prefix = paths[0].split('/').slice(0, -1);
	for (const path of paths) {
		const folders = path.split('/').slice(0, -1);
		let i = 0;
		while (i < prefix.length && i < folders.length && prefix[i] === folders[i]) {
			i++;
		}
		prefix = prefix.slice(0, i);
	}
	return prefix.join('/');
}

function relative(root: string, path: string): string {
	return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function topFolder(root: string, path: string): string {
	const rest = relative(root, path);
	const slash = rest.indexOf('/');
	return slash === -1 ? '' : rest.slice(0, slash);
}

/** Subsystems found in the graph, the files everything goes through, and the bridges nobody would guess */
export function analyzeCodeGraph(graph: CodeGraph): CodeGraphAnalysis {
	const files = [...new Set(graph.nodes.filter(node => node.kind === 'file').map(node => node.file))].sort();
	const root = commonFolder(files);
	const links = fileLinksOf(graph);

	const indexOf = new Map(files.map((file, index) => [file, index]));
	const degreeOf = new Map<string, number>(files.map(file => [file, 0]));
	const weighted: WeightedLink[] = [];
	for (const link of links) {
		const a = indexOf.get(link.from);
		const b = indexOf.get(link.to);
		if (a === undefined || b === undefined) {
			continue;
		}
		weighted.push({ a, b, weight: 1 });
		degreeOf.set(link.from, degreeOf.get(link.from)! + 1);
		degreeOf.set(link.to, degreeOf.get(link.to)! + 1);
	}

	const membership = detectCommunities(files.length, weighted);
	const communityOf = new Map(files.map((file, index) => [file, membership[index]]));

	const members = new Map<number, string[]>();
	files.forEach((file, index) => {
		const list = members.get(membership[index]) ?? [];
		list.push(file);
		members.set(membership[index], list);
	});
	const internal = new Map<number, number>();
	for (const link of links) {
		const community = communityOf.get(link.from);
		if (community !== undefined && community === communityOf.get(link.to)) {
			internal.set(community, (internal.get(community) ?? 0) + 1);
		}
	}

	const byDegree = (a: string, b: string) => degreeOf.get(b)! - degreeOf.get(a)! || a.localeCompare(b);
	const groups = [...members.entries()].filter(([, list]) => list.length >= 2).sort(([a], [b]) => a - b);
	const folderLabels = groups.map(([, list]) => {
		const folder = relative(root, commonFolder(list));
		return folder === root || folder === '' ? '' : folder.split('/').slice(-2).join('/');
	});
	const repeated = new Set(folderLabels.filter((label, index) => label && folderLabels.indexOf(label) !== index));
	const subsystems: Subsystem[] = groups.map(([id, list], index) => {
		const sorted = [...list].sort(byDegree);
		const hub = sorted[0];
		const folder = folderLabels[index];
		// One folder split into two subsystems, or files with no folder in common: the hub tells them apart
		const label = !folder ? basename(hub) : repeated.has(folder) ? `${folder} · ${basename(hub)}` : folder;
		return { id, label, files: sorted, hub, internalLinks: internal.get(id) ?? 0 };
	});

	return { root, links, communityOf, degreeOf, subsystems, report: reportOf(root, files, links, communityOf, degreeOf, new Set(subsystems.map(subsystem => subsystem.id))) };
}

function reportOf(root: string, files: readonly string[], links: readonly FileLink[], communityOf: ReadonlyMap<string, number>, degreeOf: ReadonlyMap<string, number>, subsystemIds: ReadonlySet<number>): CodeGraphReport {
	const provenance: Record<EdgeProvenance, number> = { extracted: 0, inferred: 0, ambiguous: 0 };
	for (const link of links) {
		provenance[link.provenance]++;
	}

	const hubs = files
		.filter(file => degreeOf.get(file)! > 0)
		.sort((a, b) => degreeOf.get(b)! - degreeOf.get(a)! || a.localeCompare(b))
		.slice(0, REPORT_HUBS)
		.map(file => ({ file, degree: degreeOf.get(file)!, subsystem: communityOf.get(file)! }));

	// One candidate per pair of subsystems: the rarest bridges are the surprise, and a pair joined by forty links is not one
	const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
	const pairCount = new Map<string, number>();
	const firstOfPair = new Map<string, FileLink>();
	for (const link of links) {
		const a = communityOf.get(link.from)!;
		const b = communityOf.get(link.to)!;
		if (a === b) {
			continue;
		}
		const key = pairKey(a, b);
		pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
		if (!firstOfPair.has(key)) {
			firstOfPair.set(key, link);
		}
	}
	const surprising = [...firstOfPair.entries()]
		.map(([key, link]) => ({
			link,
			fromSubsystem: communityOf.get(link.from)!,
			toSubsystem: communityOf.get(link.to)!,
			bridgeCount: pairCount.get(key)!,
			crossesFolders: topFolder(root, link.from) !== topFolder(root, link.to),
		}))
		// A lone file is a community of one, and a link to it bridges nothing: only links between real subsystems count
		.filter(entry => subsystemIds.has(entry.fromSubsystem) && subsystemIds.has(entry.toSubsystem))
		.sort((a, b) => a.bridgeCount - b.bridgeCount
			|| Number(b.crossesFolders) - Number(a.crossesFolders)
			|| a.link.from.localeCompare(b.link.from) || a.link.to.localeCompare(b.link.to))
		.slice(0, REPORT_SURPRISING);

	return {
		fileCount: files.length,
		linkCount: links.length,
		provenance,
		hubs,
		surprising,
		isolated: files.filter(file => degreeOf.get(file) === 0),
	};
}

function passes(link: FileLink, filter: CodeGraphViewFilter): boolean {
	return filter.kinds.has(link.kind) && (!filter.factsOnly || link.provenance === 'extracted');
}

/** The whole project at a glance: one node per subsystem, sized by its files, joined where any file of one links the other */
export function overviewView(analysis: CodeGraphAnalysis, filter: CodeGraphViewFilter): IGraphView {
	const shown = new Set(analysis.subsystems.map(subsystem => subsystem.id));
	const nodes: IGraphViewNode[] = analysis.subsystems.map(subsystem => ({
		id: subsystemNodeId(subsystem.id),
		label: subsystem.label,
		group: String(subsystem.id),
		// Drawn by the logarithm of its size: a subsystem of 1800 files at full scale would cover the map,
		// And the count stays in the hover text and the report
		weight: Math.log2(subsystem.files.length + 1) ** 2,
		title: `${subsystem.label} — ${subsystem.files.length} · ${relative(analysis.root, subsystem.hub)}`,
	}));
	const pairs = new Set<string>();
	const edges: IGraphViewEdge[] = [];
	for (const link of analysis.links) {
		if (!passes(link, filter)) {
			continue;
		}
		const a = analysis.communityOf.get(link.from)!;
		const b = analysis.communityOf.get(link.to)!;
		if (a === b || !shown.has(a) || !shown.has(b)) {
			continue;
		}
		const key = a < b ? `${a}:${b}` : `${b}:${a}`;
		if (!pairs.has(key)) {
			pairs.add(key);
			edges.push({ from: subsystemNodeId(a), to: subsystemNodeId(b) });
		}
	}
	return { nodes, edges };
}

export interface SubsystemView extends IGraphView {
	/** Files of the subsystem left out by the size limit */
	readonly hiddenFiles: number;
}

/**
 * One subsystem opened up: its files, plus every other subsystem it reaches drawn as a single node
 * The neighbours keep the picture honest about where the subsystem leads without pulling their files in
 */
export function subsystemView(analysis: CodeGraphAnalysis, id: number, filter: CodeGraphViewFilter): SubsystemView {
	const subsystem = analysis.subsystems.find(candidate => candidate.id === id);
	if (!subsystem) {
		return { nodes: [], edges: [], hiddenFiles: 0 };
	}
	const files = subsystem.files.slice(0, SUBSYSTEM_VIEW_LIMIT);
	const inside = new Set(files);
	const nodes: IGraphViewNode[] = files.map(file => ({
		id: file,
		label: basename(file),
		group: String(id),
		// By the logarithm of its links, like the subsystems on the map: a hub with thousands of links drawn at full scale
		// Covers the whole subsystem it sits in
		weight: Math.log2(analysis.degreeOf.get(file)! + 1) ** 2,
		title: relative(analysis.root, file),
	}));
	const labelOf = new Map(analysis.subsystems.map(candidate => [candidate.id, candidate.label]));
	const neighbours = new Map<number, IGraphViewNode>();
	const seen = new Set<string>();
	const edges: IGraphViewEdge[] = [];
	const addEdge = (from: string, to: string) => {
		const key = from < to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
		if (!seen.has(key)) {
			seen.add(key);
			edges.push({ from, to });
		}
	};
	for (const link of analysis.links) {
		if (!passes(link, filter)) {
			continue;
		}
		const fromInside = inside.has(link.from);
		const toInside = inside.has(link.to);
		if (fromInside && toInside) {
			addEdge(link.from, link.to);
			continue;
		}
		if (!fromInside && !toInside) {
			continue;
		}
		const [own, other] = fromInside ? [link.from, link.to] : [link.to, link.from];
		const otherId = analysis.communityOf.get(other)!;
		// A file of this subsystem past the size limit is not a neighbour, and a lone file has no subsystem to stand for it
		if (otherId === id || !labelOf.has(otherId)) {
			continue;
		}
		if (!neighbours.has(otherId)) {
			neighbours.set(otherId, {
				id: subsystemNodeId(otherId),
				label: labelOf.get(otherId)!,
				group: String(otherId),
				weight: 1,
			});
		}
		addEdge(own, subsystemNodeId(otherId));
	}
	return { nodes: [...nodes, ...neighbours.values()], edges, hiddenFiles: subsystem.files.length - files.length };
}

/** Plain-text report for the agent: the same facts the panel shows a person */
export function renderReport(analysis: CodeGraphAnalysis): string {
	const { report, root } = analysis;
	const rel = (path: string) => relative(root, path);
	const labelOf = new Map(analysis.subsystems.map(subsystem => [subsystem.id, subsystem.label]));
	const subsystemName = (id: number) => labelOf.get(id) ?? '(lone file)';
	const lines: string[] = [];
	lines.push(`Project graph: ${report.fileCount} files, ${report.linkCount} links between files (extracted ${report.provenance.extracted}, inferred ${report.provenance.inferred}, ambiguous ${report.provenance.ambiguous}), root ${root || '/'}`);
	lines.push('');
	lines.push(`Subsystems (${analysis.subsystems.length}, largest first; detected from the links, not from folders):`);
	for (const subsystem of analysis.subsystems.slice(0, 20)) {
		lines.push(`- ${subsystem.label}: ${subsystem.files.length} files, hub ${rel(subsystem.hub)}`);
	}
	if (analysis.subsystems.length > 20) {
		lines.push(`- … and ${analysis.subsystems.length - 20} smaller`);
	}
	lines.push('');
	lines.push('Hub files (everything flows through them; read these first to understand the project):');
	for (const hub of report.hubs) {
		lines.push(`- ${rel(hub.file)} — ${hub.degree} links, subsystem ${subsystemName(hub.subsystem)}`);
	}
	lines.push('');
	lines.push('Surprising links (rare bridges between subsystems; often a layering leak or a hidden dependency):');
	for (const entry of report.surprising) {
		const bridge = entry.bridgeCount === 1 ? 'the only link' : `one of ${entry.bridgeCount} links`;
		lines.push(`- ${rel(entry.link.from)} --${entry.link.kind} (${entry.link.provenance})--> ${rel(entry.link.to)}: ${bridge} between ${subsystemName(entry.fromSubsystem)} and ${subsystemName(entry.toSubsystem)}`);
	}
	lines.push('');
	lines.push(`Isolated files (no known links in or out): ${report.isolated.length}`);
	return lines.join('\n');
}
