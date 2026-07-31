/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Code graph — pure core (no `vscode` imports, no I/O).
 *
 * Answers a different question than the embedding index does. `repoIndexerService` answers
 * "where is this written about at all" by similarity; this graph answers "what is connected to
 * what, and how do we know" — every edge carries its provenance, so an agent can tell a fact
 * read out of the source from a guess made by a resolver.
 *
 * The graph is a PROJECTION of data the indexer already collects (file paths, symbol names,
 * import specifiers) plus the "why" notes parsed here. There is deliberately no second corpus:
 * two indexes over one repository drift apart by construction.
 */

// ── Model ─────────────────────────────────────────────────────────────────────

export type CodeNodeKind =
	/** A source file. */
	| 'file'
	/** A named declaration inside a file (function, class, interface, …). */
	| 'symbol'
	/** A prose explanation attached to code: NOTE:/WHY:/HACK:/TODO:/FIXME: comments. */
	| 'note';

export type CodeEdgeKind =
	/** file → symbol it declares. */
	| 'defines'
	/** file → file it imports. */
	| 'imports'
	/** symbol → symbol it invokes. Not produced by this core yet — see `buildCodeGraph`. */
	| 'calls'
	/** note → the file or symbol it explains. */
	| 'explains';

/**
 * How an edge came to be. The distinction is the whole point of the graph: an agent that
 * cannot tell "read from the source" from "guessed by a resolver" will state guesses as facts.
 */
export type EdgeProvenance =
	/** Read verbatim out of the source (a declaration, a literal import path that exists). */
	| 'extracted'
	/** Derived by a resolver rule (extension or index-file completion) with a single outcome. */
	| 'inferred'
	/** Several equally plausible targets; the edge points at one of them, chosen deterministically. */
	| 'ambiguous';

export interface CodeGraphNode {
	readonly id: string;
	readonly kind: CodeNodeKind;
	/** Human-readable name: file path, symbol name, or the note text. */
	readonly label: string;
	/** Owning file — every node belongs to one, including notes and symbols. */
	readonly file: string;
	/** 1-based line, when the source of the node carried a position. */
	readonly line?: number;
}

export interface CodeGraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: CodeEdgeKind;
	readonly provenance: EdgeProvenance;
}

export interface CodeGraph {
	readonly nodes: readonly CodeGraphNode[];
	readonly edges: readonly CodeGraphEdge[];
}

// ── Node ids ──────────────────────────────────────────────────────────────────

export function fileNodeId(path: string): string {
	return `file:${path}`;
}

export function symbolNodeId(path: string, name: string): string {
	return `symbol:${path}#${name}`;
}

export function noteNodeId(path: string, line: number): string {
	return `note:${path}#L${line}`;
}

// ── Input (what a builder feeds in) ───────────────────────────────────────────

export interface CodeGraphSymbolInput {
	readonly name: string;
	/** 1-based range, when the symbol provider gave one. Enables attaching notes to symbols. */
	readonly startLine?: number;
	readonly endLine?: number;
}

export interface CodeGraphNoteInput {
	/** 1-based line the note sits on. */
	readonly line: number;
	/** Marker without the colon: NOTE, WHY, HACK, TODO, FIXME. */
	readonly marker: string;
	readonly text: string;
}

export interface CodeGraphFileInput {
	/** Absolute, forward-slash path. Used verbatim as the node identity. */
	readonly path: string;
	readonly symbols?: readonly CodeGraphSymbolInput[];
	/** Import specifiers exactly as written in the source (`./foo`, `../bar/baz`). */
	readonly importSpecifiers?: readonly string[];
	readonly notes?: readonly CodeGraphNoteInput[];
}

// ── Import resolution ─────────────────────────────────────────────────────────

/** Extensions a bare specifier may be completed with, in the order we try them. */
const IMPORT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'] as const;
const INDEX_BASENAMES = ['index', '__init__'] as const;

/** Join and normalize a POSIX-ish path, resolving `.` and `..` without touching the file system. */
function normalizePath(path: string): string {
	const isAbsolute = path.startsWith('/');
	const out: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (out.length > 0 && out[out.length - 1] !== '..') {
				out.pop();
			} else if (!isAbsolute) {
				out.push('..');
			}
			continue;
		}
		out.push(segment);
	}
	return (isAbsolute ? '/' : '') + out.join('/');
}

function dirnameOf(path: string): string {
	const cut = path.lastIndexOf('/');
	return cut <= 0 ? '/' : path.slice(0, cut);
}

export interface ResolvedImport {
	readonly path: string;
	readonly provenance: EdgeProvenance;
}

/**
 * Resolve one import specifier against the set of files we know about.
 *
 * Relative specifiers only: a bare `react` or `@scope/pkg` is a dependency, not a node of this
 * graph, and returns `undefined` rather than a fabricated edge.
 *
 * Provenance ladder:
 *  - the specifier names an existing file verbatim → `extracted` (nothing was guessed);
 *  - exactly one completion (extension or index file) exists → `inferred`;
 *  - several completions exist → `ambiguous`, pointing at the first in sorted order so the
 *    graph stays deterministic across runs.
 */
export function resolveImportTarget(fromPath: string, specifier: string, knownFiles: ReadonlySet<string>): ResolvedImport | undefined {
	if (!specifier.startsWith('.')) {
		return undefined;
	}
	const base = normalizePath(`${dirnameOf(fromPath)}/${specifier}`);
	if (knownFiles.has(base)) {
		return { path: base, provenance: 'extracted' };
	}

	const candidates: string[] = [];
	for (const extension of IMPORT_EXTENSIONS) {
		if (knownFiles.has(base + extension)) {
			candidates.push(base + extension);
		}
		for (const indexName of INDEX_BASENAMES) {
			const asIndex = `${base}/${indexName}${extension}`;
			if (knownFiles.has(asIndex)) {
				candidates.push(asIndex);
			}
		}
	}
	if (candidates.length === 0) {
		return undefined;
	}
	if (candidates.length === 1) {
		return { path: candidates[0], provenance: 'inferred' };
	}
	return { path: [...candidates].sort()[0], provenance: 'ambiguous' };
}

// ── "Why" notes ───────────────────────────────────────────────────────────────

/**
 * Markers worth turning into graph nodes. These carry intent that the code itself cannot state:
 * why something is done the odd way, what must not be touched, what is deliberately left undone.
 */
const NOTE_MARKERS = ['WHY', 'NOTE', 'HACK', 'FIXME', 'TODO'] as const;
const NOTE_PATTERN = new RegExp(`(?://|#|/\\*|\\*)\\s*(${NOTE_MARKERS.join('|')})\\s*:\\s*(.+)$`);

/** Trailing comment punctuation that adds nothing to the note text. */
const NOTE_TAIL_PATTERN = /\s*(?:\*\/|-->)\s*$/;

/**
 * Pull "why" notes out of file content. Comment-syntax aware only to the degree that matters:
 * the marker must follow a comment opener, so a string literal containing "TODO:" is not a note.
 */
export function parseWhyNotes(content: string): CodeGraphNoteInput[] {
	const notes: CodeGraphNoteInput[] = [];
	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const match = NOTE_PATTERN.exec(lines[index]);
		if (!match) {
			continue;
		}
		const text = match[2].replace(NOTE_TAIL_PATTERN, '').trim();
		if (text.length > 0) {
			notes.push({ line: index + 1, marker: match[1], text });
		}
	}
	return notes;
}

// ── Build ─────────────────────────────────────────────────────────────────────

/**
 * Project the inputs into a graph.
 *
 * `calls` edges are NOT produced here: a truthful call edge needs per-language resolution of the
 * callee, which the indexer's data cannot support. Emitting guessed call edges would poison the
 * one property that makes this graph worth having — that an edge means what it says.
 */
export function buildCodeGraph(files: readonly CodeGraphFileInput[]): CodeGraph {
	const nodes: CodeGraphNode[] = [];
	const edges: CodeGraphEdge[] = [];
	const knownFiles = new Set(files.map(file => file.path));

	for (const file of files) {
		nodes.push({ id: fileNodeId(file.path), kind: 'file', label: file.path, file: file.path });

		for (const symbol of file.symbols ?? []) {
			if (!symbol.name) {
				continue;
			}
			const id = symbolNodeId(file.path, symbol.name);
			if (nodes.some(node => node.id === id)) {
				continue; // same name declared twice in one file — one node is enough
			}
			nodes.push({ id, kind: 'symbol', label: symbol.name, file: file.path, line: symbol.startLine });
			// Read straight out of the declaration list: nothing is guessed about who declares what.
			edges.push({ from: fileNodeId(file.path), to: id, kind: 'defines', provenance: 'extracted' });
		}

		for (const specifier of file.importSpecifiers ?? []) {
			const resolved = resolveImportTarget(file.path, specifier, knownFiles);
			if (!resolved || resolved.path === file.path) {
				continue;
			}
			edges.push({ from: fileNodeId(file.path), to: fileNodeId(resolved.path), kind: 'imports', provenance: resolved.provenance });
		}

		for (const note of file.notes ?? []) {
			const id = noteNodeId(file.path, note.line);
			nodes.push({ id, kind: 'note', label: `${note.marker}: ${note.text}`, file: file.path, line: note.line });
			// Attach to the innermost symbol whose range covers the note; fall back to the file.
			const owner = smallestEnclosingSymbol(file, note.line);
			edges.push({
				from: id,
				to: owner ? symbolNodeId(file.path, owner.name) : fileNodeId(file.path),
				kind: 'explains',
				// Inside a known range it is a fact; without ranges the file-level attachment is a fallback.
				provenance: owner ? 'extracted' : 'inferred',
			});
		}
	}

	return { nodes, edges };
}

/** Innermost symbol whose range contains `line`; undefined when ranges are absent or none match. */
function smallestEnclosingSymbol(file: CodeGraphFileInput, line: number): CodeGraphSymbolInput | undefined {
	let best: CodeGraphSymbolInput | undefined;
	for (const symbol of file.symbols ?? []) {
		if (typeof symbol.startLine !== 'number' || typeof symbol.endLine !== 'number') {
			continue;
		}
		if (line < symbol.startLine || line > symbol.endLine) {
			continue;
		}
		if (!best || (symbol.endLine - symbol.startLine) < (best.endLine! - best.startLine!)) {
			best = symbol;
		}
	}
	return best;
}

// ── Queries ───────────────────────────────────────────────────────────────────

export interface NeighborResult {
	readonly node: CodeGraphNode;
	readonly outgoing: readonly { edge: CodeGraphEdge; node: CodeGraphNode }[];
	readonly incoming: readonly { edge: CodeGraphEdge; node: CodeGraphNode }[];
}

/** Direct neighbours of a node, both directions, each paired with the edge that got us there. */
export function neighbors(graph: CodeGraph, nodeId: string): NeighborResult | undefined {
	const node = graph.nodes.find(candidate => candidate.id === nodeId);
	if (!node) {
		return undefined;
	}
	const byId = new Map(graph.nodes.map(candidate => [candidate.id, candidate]));
	const outgoing: { edge: CodeGraphEdge; node: CodeGraphNode }[] = [];
	const incoming: { edge: CodeGraphEdge; node: CodeGraphNode }[] = [];
	for (const edge of graph.edges) {
		if (edge.from === nodeId) {
			const other = byId.get(edge.to);
			if (other) { outgoing.push({ edge, node: other }); }
		}
		if (edge.to === nodeId) {
			const other = byId.get(edge.from);
			if (other) { incoming.push({ edge, node: other }); }
		}
	}
	return { node, outgoing, incoming };
}

/**
 * Shortest trace between two nodes, edges treated as undirected — "how are these two related"
 * rarely cares which way the import points. Returns the node ids in order, or undefined when
 * nothing connects them within `maxDepth` hops.
 */
export function pathBetween(graph: CodeGraph, fromId: string, toId: string, maxDepth: number = 6): string[] | undefined {
	if (fromId === toId) {
		return graph.nodes.some(node => node.id === fromId) ? [fromId] : undefined;
	}
	const adjacency = new Map<string, string[]>();
	for (const edge of graph.edges) {
		if (!adjacency.has(edge.from)) { adjacency.set(edge.from, []); }
		if (!adjacency.has(edge.to)) { adjacency.set(edge.to, []); }
		adjacency.get(edge.from)!.push(edge.to);
		adjacency.get(edge.to)!.push(edge.from);
	}

	const cameFrom = new Map<string, string>();
	const visited = new Set<string>([fromId]);
	let frontier = [fromId];
	for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
		const next: string[] = [];
		for (const current of frontier) {
			for (const neighbor of adjacency.get(current) ?? []) {
				if (visited.has(neighbor)) {
					continue;
				}
				visited.add(neighbor);
				cameFrom.set(neighbor, current);
				if (neighbor === toId) {
					const trace = [toId];
					let step = toId;
					while (cameFrom.has(step)) {
						step = cameFrom.get(step)!;
						trace.push(step);
					}
					return trace.reverse();
				}
				next.push(neighbor);
			}
		}
		frontier = next;
	}
	return undefined;
}

/**
 * The part of the graph within `depth` hops of the seeds — what an agent should read instead of
 * grepping blindly. Edges are kept only when both ends survived, so the result is a valid graph.
 */
export function scopedSubgraph(graph: CodeGraph, seedIds: readonly string[], depth: number = 1): CodeGraph {
	const byId = new Map(graph.nodes.map(node => [node.id, node]));
	const kept = new Set(seedIds.filter(id => byId.has(id)));
	let frontier = [...kept];
	for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
		const next: string[] = [];
		for (const edge of graph.edges) {
			for (const [near, far] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
				if (frontier.includes(near) && !kept.has(far) && byId.has(far)) {
					kept.add(far);
					next.push(far);
				}
			}
		}
		frontier = next;
	}
	return {
		nodes: graph.nodes.filter(node => kept.has(node.id)),
		edges: graph.edges.filter(edge => kept.has(edge.from) && kept.has(edge.to)),
	};
}
