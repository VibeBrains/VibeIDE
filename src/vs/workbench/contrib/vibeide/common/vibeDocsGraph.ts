/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure link/graph model behind the docs graph view.
 *
 * This mirrors `scripts/vibe-docs-graph.mjs` deliberately: the script gates CI and must stay
 * dependency-free (it runs without `npm ci`), so it cannot import this module. The duplication is
 * intentional and pinned by a behavioural parity test — see `test/node/vibeDocsGraphParity.test.ts`.
 * Change a rule here and you MUST change it there.
 */

import { posix } from '../../../../base/common/path.js';

/** Navigation root of the docs tree; reachability is measured from here. */
export const DOC_GRAPH_NAV_ROOT = 'README.md';

export type DocLinkKind = 'relative' | 'wiki';

export interface IDocRawLink {
	readonly target: string;
	readonly kind: DocLinkKind;
}

export interface IDocGraphNode {
	/** POSIX path relative to the docs root, including `.md`. */
	readonly id: string;
	/** Basename without extension — what the graph draws. */
	readonly label: string;
	/** Top-level folder (`ui`, `architecture`, …); empty for files sitting at the docs root. */
	readonly domain: string;
	/** Inbound + outbound links; drives node size. */
	readonly degree: number;
	/** Reachable from {@link DOC_GRAPH_NAV_ROOT} by following links. */
	readonly reachable: boolean;
	/**
	 * Headings of the note, first one first — what it is ABOUT, in the author's own words.
	 *
	 * The graph itself only ever needed links, but a retriever has nothing to match a task against
	 * without them: a filename says `modelQuirks`, a heading says «симптом ‹модель не умеет
	 * инструменты› проверять на стороне сервера». Kept as plain text, capped, so the graph stays a
	 * structure and does not become a second copy of the corpus.
	 */
	readonly headings: readonly string[];
}

export interface IDocGraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: DocLinkKind;
}

export interface IDocDeadLink {
	readonly from: string;
	readonly target: string;
	readonly kind: DocLinkKind;
}

export interface IDocGraph {
	readonly nodes: readonly IDocGraphNode[];
	readonly edges: readonly IDocGraphEdge[];
	readonly deadLinks: readonly IDocDeadLink[];
}

export interface IDocFile {
	/** POSIX path relative to the docs root, including `.md`. */
	readonly id: string;
	readonly content: string;
	/**
	 * A file that lives OUTSIDE the docs tree but points into it — today, project skills.
	 *
	 * They are drawn so it is visible which knowledge a skill leans on, but they take no part in
	 * the gate: their links must not make a stranded doc look reachable (that would blind the
	 * `unreachable` check), they are never reported unreachable themselves, and their broken
	 * links are not docs defects — a skill may legitimately reference files we do not index.
	 */
	readonly external?: boolean;
}

/** Domain assigned to external nodes, so the view can colour and filter them as one group. */
export const DOC_GRAPH_EXTERNAL_DOMAIN = 'skills';

/**
 * Relative markdown link: `[text](path.md)` / `[text](path.md#anchor)`.
 * Absolute URLs, bare anchors and Cursor-style `mdc:` links are excluded — `mdc:` is resolved
 * workspace-relative at runtime, so resolving it against the containing doc invents a dead link.
 */
const MD_LINK_RE = /\[([^\]]+)\]\((?!https?:|mdc:|#)([^)#\s]+\.md)(?:#[^)]*)?\)/g;

/** Obsidian-style `[[target]]`, `[[target#anchor]]`, `[[target|alias]]`. */
const WIKI_LINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/**
 * Fenced blocks and inline code are prose ABOUT links, not links. `docs/roadmap.md` documents the
 * checker itself and the entry template spells `[[wikilink]]` out as a convention — both would
 * otherwise register as phantom links.
 */
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

export function stripCode(text: string): string {
	return text.replace(CODE_RE, '');
}

export function isTemplateId(id: string): boolean {
	return posix.basename(id).startsWith('_template');
}

/** Both link syntaxes, code stripped. Targets are raw — resolution happens against the file set. */
export function parseDocLinks(content: string): IDocRawLink[] {
	const text = stripCode(content);
	const links: IDocRawLink[] = [];
	for (const match of text.matchAll(MD_LINK_RE)) {
		links.push({ target: match[2], kind: 'relative' });
	}
	for (const match of text.matchAll(WIKI_LINK_RE)) {
		links.push({ target: match[1].trim(), kind: 'wiki' });
	}
	return links;
}

/** Placeholder paths: links to a template, and the `../topic/file.md` examples inside one. */
function isPlaceholderLink(fromId: string, target: string): boolean {
	return isTemplateId(fromId) || target.includes('/_template') || posix.basename(target).startsWith('_template');
}

function resolveRelative(fromId: string, target: string): string | undefined {
	const joined = posix.join(posix.dirname(fromId), target);
	// `join` normalises `..`; anything escaping the docs root keeps a leading `..`.
	return joined.startsWith('..') ? undefined : joined;
}

/**
 * Wikilinks carry no path, so they resolve by name: an exact docs-relative path first, then a
 * unique basename. An ambiguous basename resolves to nothing and is reported dead — silently
 * picking one of several same-named docs would draw an edge that isn't there.
 */
function resolveWiki(target: string, exact: ReadonlySet<string>, byBasename: ReadonlyMap<string, string[]>): string | undefined {
	const normalised = target.replace(/\\/g, '/').trim();
	const withExt = normalised.endsWith('.md') ? normalised : `${normalised}.md`;
	if (exact.has(withExt)) {
		return withExt;
	}
	const hits = byBasename.get(posix.basename(withExt, '.md').toLowerCase());
	return hits?.length === 1 ? hits[0] : undefined;
}

/** `docs/specs/**` holds workspace specs authored by the Specs pane — product data, not docs. */
function isExcluded(id: string): boolean {
	return id.startsWith('specs/');
}

export function buildDocGraph(files: readonly IDocFile[]): IDocGraph {
	const included = files.filter(f => !isExcluded(f.id));
	const docs = included.filter(f => !f.external);
	const exact = new Set(docs.map(f => f.id));

	const byBasename = new Map<string, string[]>();
	for (const file of docs) {
		const key = posix.basename(file.id, '.md').toLowerCase();
		const bucket = byBasename.get(key);
		if (bucket) {
			bucket.push(file.id);
		} else {
			byBasename.set(key, [file.id]);
		}
	}

	const edges: IDocGraphEdge[] = [];
	const deadLinks: IDocDeadLink[] = [];
	const outgoing = new Map<string, Set<string>>(included.map(f => [f.id, new Set<string>()]));
	const degree = new Map<string, number>(included.map(f => [f.id, 0]));
	/** Reachability walks docs only — see the note on `IDocFile.external`. */
	const docOutgoing = new Map<string, Set<string>>(docs.map(f => [f.id, new Set<string>()]));

	const addEdge = (from: string, to: string, kind: DocLinkKind): void => {
		if (outgoing.get(from)!.has(to)) {
			return; // one edge per pair, however many times a doc links to it
		}
		outgoing.get(from)!.add(to);
		docOutgoing.get(from)?.add(to);
		edges.push({ from, to, kind });
		degree.set(from, degree.get(from)! + 1);
		degree.set(to, (degree.get(to) ?? 0) + 1);
	};

	for (const file of included) {
		for (const link of parseDocLinks(file.content)) {
			if (isPlaceholderLink(file.id, link.target)) {
				continue;
			}
			if (link.kind === 'relative') {
				const resolved = resolveRelative(file.id, link.target);
				// Escaping the docs root (CLAUDE.md and friends) or pointing at specs is
				// out of scope, not a defect — the script draws the same line.
				if (resolved === undefined || isExcluded(resolved)) {
					continue;
				}
				if (!exact.has(resolved)) {
					if (!file.external) {
						deadLinks.push({ from: file.id, target: link.target, kind: link.kind });
					}
					continue;
				}
				addEdge(file.id, resolved, link.kind);
			} else {
				const resolved = resolveWiki(link.target, exact, byBasename);
				if (resolved === undefined) {
					if (!file.external) {
						deadLinks.push({ from: file.id, target: link.target, kind: link.kind });
					}
					continue;
				}
				addEdge(file.id, resolved, link.kind);
			}
		}
	}

	const reachable = collectReachable(docOutgoing);
	const nodes: IDocGraphNode[] = included.map(file => ({
		id: file.id,
		label: externalLabel(file) ?? posix.basename(file.id, '.md'),
		domain: file.external ? DOC_GRAPH_EXTERNAL_DOMAIN : file.id.includes('/') ? file.id.slice(0, file.id.indexOf('/')) : '',
		degree: degree.get(file.id) ?? 0,
		// Templates are deliberately unlinked skeletons — never flag them as stranded.
		reachable: file.external || reachable.has(file.id) || isTemplateId(file.id),
		headings: parseDocHeadings(file.content),
	}));

	return { nodes, edges, deadLinks };
}

/** How many headings of one note are kept — enough to describe it, not enough to store it. */
const MAX_HEADINGS_PER_DOC = 12;
/** Longer than this a heading is a sentence, and its tail adds noise rather than meaning. */
const MAX_HEADING_CHARS = 120;

/**
 * Markdown headings of a document, in order, stripped of markers.
 *
 * Fenced code is skipped: a `# comment` inside a shell block is not a heading, and treating it as
 * one would file the note under whatever that comment happened to mention.
 */
export function parseDocHeadings(content: string): string[] {
	const out: string[] = [];
	let inFence = false;
	for (const line of content.split(/\r?\n/)) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!heading) {
			continue;
		}
		const text = heading[2].replace(/[`*_[\]]/g, '').trim();
		if (text) {
			out.push(text.slice(0, MAX_HEADING_CHARS));
		}
		if (out.length >= MAX_HEADINGS_PER_DOC) {
			break;
		}
	}
	return out;
}

/**
 * A skill is named by its folder: every one of them is a file called `SKILL.md`, so the basename
 * would label them all identically.
 */
function externalLabel(file: IDocFile): string | undefined {
	if (!file.external) {
		return undefined;
	}
	const parts = file.id.split('/');
	return parts.length > 1 ? parts[parts.length - 2] : posix.basename(file.id, '.md');
}

/** BFS from the navigation root. A doc you cannot walk to from `README.md` is invisible. */
function collectReachable(outgoing: ReadonlyMap<string, Set<string>>): Set<string> {
	const reachable = new Set<string>([DOC_GRAPH_NAV_ROOT]);
	const queue: string[] = [DOC_GRAPH_NAV_ROOT];
	while (queue.length > 0) {
		for (const next of outgoing.get(queue.pop()!) ?? []) {
			if (!reachable.has(next)) {
				reachable.add(next);
				queue.push(next);
			}
		}
	}
	return reachable;
}

/** Neighbourhood of `id` up to `depth` hops, ignoring direction — backs the sidebar's local graph. */
export function localGraph(graph: IDocGraph, id: string, depth: number): IDocGraph {
	const keep = new Set<string>([id]);
	let frontier = new Set<string>([id]);
	for (let i = 0; i < depth; i++) {
		const next = new Set<string>();
		for (const edge of graph.edges) {
			if (frontier.has(edge.from) && !keep.has(edge.to)) { next.add(edge.to); }
			if (frontier.has(edge.to) && !keep.has(edge.from)) { next.add(edge.from); }
		}
		for (const n of next) { keep.add(n); }
		frontier = next;
	}
	return {
		nodes: graph.nodes.filter(n => keep.has(n.id)),
		edges: graph.edges.filter(e => keep.has(e.from) && keep.has(e.to)),
		deadLinks: graph.deadLinks.filter(d => keep.has(d.from)),
	};
}
