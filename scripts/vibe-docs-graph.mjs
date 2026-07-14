/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Roadmap Y.6 — docs graph checker.
//
// Scans `docs/**/*.md` for relative-path markdown links (`[text](relative/path.md)`)
// and emits a Mermaid graph to stdout. Gates three defects:
//
//   dead links   — the target path does not exist.
//   unindexed    — an entry under `docs/knowledge/**` missing from `docs/knowledge/README.md`.
//                  That index is the ONLY list of entries: an entry absent from it is
//                  undiscoverable however well it is cross-linked. A cluster of files
//                  linking to each other has non-zero degree while staying invisible from
//                  the index — that is exactly how the whole `toolSystem/` domain went
//                  unlisted for seven weeks while a degree-based "orphan" check stayed green.
//   unreachable  — a doc you cannot reach from `docs/README.md` by following links.
//                  `docs/README.md` is the navigation root. This check replaced the old
//                  degree-based orphan check (no incoming AND no outgoing links), which was
//                  strictly weaker: it passed any file that merely linked somewhere. 29 docs
//                  were unreachable when this landed, because the structure section of
//                  `docs/README.md` was an ASCII tree inside a code fence — text, not links.
//
// Exempt from `unreachable`/`unindexed`: `_template*` skeletons (deliberately unlinked).
// Excluded entirely: `docs/specs/**` — workspace specs authored by the Specs pane, not docs.
//
// Usage:
//   node scripts/vibe-docs-graph.mjs                # mermaid graph to stdout
//   node scripts/vibe-docs-graph.mjs --unreachable  # list docs unreachable from docs/README.md
//   node scripts/vibe-docs-graph.mjs --dead-links   # list dead links only
//   node scripts/vibe-docs-graph.mjs --unindexed    # list knowledge entries missing from the index
//   node scripts/vibe-docs-graph.mjs --check        # exit 1 on dead links / unindexed / unreachable

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'docs');
if (!fs.existsSync(root)) {
	console.error(`directory not found: ${root}`);
	process.exit(2);
}

// Navigation root and the knowledge index, relative to `root`.
const NAV_ROOT = 'README.md';
const KNOWLEDGE_INDEX = 'knowledge/README.md';
const KNOWLEDGE_DIR = 'knowledge/';
const isTemplate = (id) => path.basename(id).startsWith('_template');

const mode = process.argv[2] ?? 'mermaid';

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			yield full;
		}
	}
}

// Relative markdown link: [text](path.md) or [text](path.md#anchor)
// Skip absolute URLs (https?://), bare-anchor links (#section) and Cursor-style
// `mdc:` links — the latter are resolved workspace-relative by
// VibeProjectRulesService at runtime, not relative to the containing doc, so
// resolving them here yields a phantom dead link.
const LINK_RE = /\[([^\]]+)\]\((?!https?:|mdc:|#)([^)#\s]+\.md)(?:#[^)]*)?\)/g;

// Fenced blocks and inline code are prose ABOUT links, not links. `docs/roadmap.md` documents this
// very script (``[text](path.md)``) and would otherwise report a phantom dead link.
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;
const stripCode = (s) => s.replace(CODE_RE, '');

const nodeIdOf = (absPath) => path.relative(root, absPath).replace(/\\/g, '/');
// `docs/specs/**` holds workspace specs written by the Specs pane — product data, not docs.
const files = [...walk(root)].filter((f) => !nodeIdOf(f).startsWith('specs/'));
const nodes = new Set(files.map(nodeIdOf));

const outgoing = new Map();
const incoming = new Map();
const deadLinks = [];

for (const file of files) {
	const id = nodeIdOf(file);
	outgoing.set(id, new Set());
	if (!incoming.has(id)) {incoming.set(id, new Set());}
	const content = stripCode(fs.readFileSync(file, 'utf8'));
	for (const m of content.matchAll(LINK_RE)) {
		const linkTarget = m[2];
		// Placeholder paths: both links to a template and links inside one (`../topic/file.md`).
		if (isTemplate(id) || linkTarget.includes('/_template') || path.basename(linkTarget).startsWith('_template')) {continue;}
		const resolved = path.resolve(path.dirname(file), linkTarget);
		const targetId = nodeIdOf(resolved);
		// Only track edges that stay within docs/ (links to CLAUDE.md etc. are out of scope).
		if (path.relative(root, resolved).startsWith('..')) {continue;}
		if (targetId.startsWith('specs/')) {continue;}
		if (!nodes.has(targetId)) {
			deadLinks.push({ from: id, target: linkTarget, resolved: targetId });
			continue;
		}
		outgoing.get(id).add(targetId);
		if (!incoming.has(targetId)) {incoming.set(targetId, new Set());}
		incoming.get(targetId).add(id);
	}
}

// Reachability from the navigation root. Replaces the old degree-based orphan check:
// that one passed any file with a single outgoing link, so a self-linking cluster stayed green.
const reachable = new Set([NAV_ROOT]);
const queue = [NAV_ROOT];
while (queue.length > 0) {
	for (const next of outgoing.get(queue.pop()) ?? []) {
		if (!reachable.has(next)) {
			reachable.add(next);
			queue.push(next);
		}
	}
}
const unreachable = [...nodes].filter((id) => !reachable.has(id) && !isTemplate(id)).sort();

// Index membership: every knowledge entry must be linked from `docs/knowledge/README.md`.
// Exempt: the index itself and `_template*` skeletons.
const INDEX_ID = KNOWLEDGE_INDEX;
const indexedIds = outgoing.get(INDEX_ID) ?? new Set();
const unindexed = [];
for (const id of nodes) {
	if (!id.startsWith(KNOWLEDGE_DIR)) {continue;}
	if (id === INDEX_ID) {continue;}
	if (isTemplate(id)) {continue;}
	if (!indexedIds.has(id)) {unindexed.push(id);}
}
unindexed.sort();

if (mode === '--unindexed') {
	if (unindexed.length === 0) {
		console.log('All entries are listed in the index.');
	} else {
		console.log(`${unindexed.length} entr(ies) missing from ${INDEX_ID}:`);
		for (const id of unindexed) {console.log(`  ${id}`);}
	}
	process.exit(0);
}

if (mode === '--unreachable') {
	if (unreachable.length === 0) {
		console.log(`All docs are reachable from ${NAV_ROOT}.`);
	} else {
		console.log(`${unreachable.length} doc(s) unreachable from ${NAV_ROOT}:`);
		for (const id of unreachable) {console.log(`  ${id}`);}
	}
	process.exit(0);
}

if (mode === '--dead-links') {
	if (deadLinks.length === 0) {
		console.log('No dead links.');
	} else {
		console.log(`${deadLinks.length} dead link(s):`);
		for (const { from, target } of deadLinks) {console.log(`  ${from} → ${target}`);}
	}
	process.exit(0);
}

if (mode === '--check') {
	const issues = [];
	if (deadLinks.length > 0) {issues.push(`${deadLinks.length} dead link(s)`);}
	if (unindexed.length > 0) {issues.push(`${unindexed.length} unindexed`);}
	if (unreachable.length > 0) {issues.push(`${unreachable.length} unreachable`);}
	if (issues.length === 0) {
		console.log(`docs graph clean (${nodes.size} files, all indexed and reachable from ${NAV_ROOT}).`);
		process.exit(0);
	}
	console.error(`docs graph issues: ${issues.join(', ')}`);
	for (const { from, target } of deadLinks) {console.error(`  dead: ${from} → ${target}`);}
	for (const id of unindexed) {console.error(`  unindexed: ${id} — add a row to ${INDEX_ID}`);}
	for (const id of unreachable) {console.error(`  unreachable: ${id} — link it from ${NAV_ROOT} (directly or via a subtree index)`);}
	process.exit(1);
}

// Default: emit Mermaid graph.
const safeId = (s) => s.replace(/[^a-zA-Z0-9]/g, '_');
const shortLabel = (s) => {
	const base = path.basename(s, '.md');
	return base.length > 32 ? base.slice(0, 30) + '…' : base;
};

console.log('```mermaid');
console.log('graph LR');
for (const id of nodes) {
	console.log(`  ${safeId(id)}["${shortLabel(id)}"]`);
}
for (const [from, targets] of outgoing) {
	for (const target of targets) {
		console.log(`  ${safeId(from)} --> ${safeId(target)}`);
	}
}
console.log('```');
console.log('');
console.log(`<!-- ${nodes.size} files, ${[...outgoing.values()].reduce((a, s) => a + s.size, 0)} edges, ${unreachable.length} unreachable, ${deadLinks.length} dead link(s) -->`);
