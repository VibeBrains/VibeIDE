/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Roadmap Y.6 — Knowledge base graph generator.
//
// Scans `docs/knowledge/**/*.md` for relative-path markdown links
// (`[text](relative/path.md)`) and emits a Mermaid graph to stdout.
// Detects orphan files (no incoming + no outgoing links), dead links
// (target path doesn't exist) and entries missing from the index.
//
// The index (`docs/knowledge/README.md`) is the ONLY list of entries: an entry
// absent from it is undiscoverable, however well it is cross-linked. Orphan
// detection does not catch this — a cluster of files linking to each other has
// non-zero degree while staying invisible from the index (that is exactly how
// the whole `tool-system/` domain went unlisted for seven weeks).
//
// Usage:
//   node scripts/vibe-docs-graph.mjs               # mermaid graph to stdout
//   node scripts/vibe-docs-graph.mjs --orphans     # list orphan files only
//   node scripts/vibe-docs-graph.mjs --dead-links  # list dead links only
//   node scripts/vibe-docs-graph.mjs --unindexed   # list entries missing from the index
//   node scripts/vibe-docs-graph.mjs --check       # exit 1 on dead links / orphans / unindexed

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), 'docs', 'knowledge');
if (!fs.existsSync(root)) {
	console.error(`directory not found: ${root}`);
	process.exit(2);
}

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

const files = [...walk(root)];
const nodeIdOf = (absPath) => path.relative(root, absPath).replace(/\\/g, '/');
const nodes = new Set(files.map(nodeIdOf));

const outgoing = new Map();
const incoming = new Map();
const deadLinks = [];

for (const file of files) {
	const id = nodeIdOf(file);
	outgoing.set(id, new Set());
	if (!incoming.has(id)) {incoming.set(id, new Set());}
	const content = fs.readFileSync(file, 'utf8');
	for (const m of content.matchAll(LINK_RE)) {
		const linkTarget = m[2];
		// Skip _template-* targets (placeholder paths).
		if (linkTarget.includes('/_template-') || path.basename(linkTarget).startsWith('_template-')) {continue;}
		const resolved = path.resolve(path.dirname(file), linkTarget);
		const targetId = nodeIdOf(resolved);
		// Only track edges that stay within docs/knowledge.
		const inKnowledge = !path.relative(root, resolved).startsWith('..');
		if (!inKnowledge) {continue;}
		if (!nodes.has(targetId)) {
			deadLinks.push({ from: id, target: linkTarget, resolved: targetId });
			continue;
		}
		outgoing.get(id).add(targetId);
		if (!incoming.has(targetId)) {incoming.set(targetId, new Set());}
		incoming.get(targetId).add(id);
	}
}

const orphans = [];
for (const id of nodes) {
	const inDeg = (incoming.get(id) ?? new Set()).size;
	const outDeg = (outgoing.get(id) ?? new Set()).size;
	// README files are intentionally entry points — exempt from orphan check.
	if (path.basename(id) === 'README.md') {continue;}
	// Files starting with `_template-` are skeletons, not real entries.
	if (path.basename(id).startsWith('_template-')) {continue;}
	if (inDeg === 0 && outDeg === 0) {orphans.push(id);}
}

// Index membership: every entry must be linked from `docs/knowledge/README.md`.
// Exempt: the index itself and `_template-*` skeletons.
const INDEX_ID = 'README.md';
const indexedIds = outgoing.get(INDEX_ID) ?? new Set();
const unindexed = [];
for (const id of nodes) {
	if (id === INDEX_ID) {continue;}
	if (path.basename(id).startsWith('_template-')) {continue;}
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

if (mode === '--orphans') {
	if (orphans.length === 0) {
		console.log('No orphan files.');
	} else {
		console.log(`${orphans.length} orphan file(s) (no in/out links):`);
		for (const id of orphans) {console.log(`  ${id}`);}
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
	if (orphans.length > 0) {issues.push(`${orphans.length} orphan(s)`);}
	if (unindexed.length > 0) {issues.push(`${unindexed.length} unindexed`);}
	if (issues.length === 0) {
		console.log(`docs graph clean (${nodes.size} files, all indexed).`);
		process.exit(0);
	}
	console.error(`docs graph issues: ${issues.join(', ')}`);
	for (const { from, target } of deadLinks) {console.error(`  dead: ${from} → ${target}`);}
	for (const id of orphans) {console.error(`  orphan: ${id}`);}
	for (const id of unindexed) {console.error(`  unindexed: ${id} — add a row to ${INDEX_ID}`);}
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
console.log(`<!-- ${nodes.size} files, ${[...outgoing.values()].reduce((a, s) => a + s.size, 0)} edges, ${orphans.length} orphan(s), ${deadLinks.length} dead link(s) -->`);
