/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Guards DI wiring for the vibeide contrib: every module that calls `registerSingleton()` must be
// reachable — transitively, through imports — from `browser/vibeide.contribution.ts`.
//
// Why this exists. `registerSingleton` only runs if the module is loaded, and a module is loaded
// only if something imports it. Move a service implementation to a new file and forget the
// side-effect import in the contribution, and the singleton is never registered: the decorator
// still exports fine, `compile-check-ts-native` is happy, `valid-layers-check` is happy — and the
// service dies at runtime, when a consumer injects it. No type checker sees this.
//
// The failure is not hypothetical. Before the common/ layer split, `mcpService` and
// `remoteCatalogService` were NOT imported by the contribution at all; they got registered only
// because some consumer happened to import them for their interface. Once the interface stays in
// common/ and the class moves to browser/, that accidental import no longer loads the class.
//
// This is a structural check, not a behavioural one: it proves the module is loaded, not that the
// service works. The behavioural oracle is `test/browser/vibeideServiceRegistration.test.ts`
// (imports the contribution, reads the real registry) plus a smoke run.
//
// Usage:
//   node scripts/vibe-service-registration-check.mjs           # report
//   node scripts/vibe-service-registration-check.mjs --check   # exit 1 if any registrar unreachable

import fs from 'node:fs';
import path from 'node:path';

const CONTRIB_ROOT = path.resolve(process.cwd(), 'src/vs/workbench/contrib/vibeide');
const ENTRY = path.join(CONTRIB_ROOT, 'browser/vibeide.contribution.ts');

if (!fs.existsSync(ENTRY)) {
	console.error(`entry point not found: ${ENTRY}`);
	process.exit(2);
}

const mode = process.argv[2] ?? 'report';

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* walk(full);
		} else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
			yield full;
		}
	}
}

// Comments can hide a `registerSingleton(` or an import-looking line, so they must go before
// matching (`sendLLMMessageService.ts` really does carry a commented-out ProxyChannel call).
//
// This is a line-based scanner, NOT a pair of strip regexes. A naive `/\/\*[\s\S]*?\*\//g` treats
// the `/*` inside a LINE comment as the start of a block: `vibeide.contribution.ts` line 256 says
// `// ... **/*.plan.md ...`, and stripping from there to the next `*/` swallowed 75 lines and ~19
// imports — which is how the first run of this script reported 17 phantom unreachable registrars.
function stripComments(src) {
	const out = [];
	let inBlock = false;
	for (let line of src.split('\n')) {
		if (inBlock) {
			const end = line.indexOf('*/');
			if (end === -1) { out.push(''); continue; }
			line = line.slice(end + 2);
			inBlock = false;
		}
		// Drop a line comment, but never mistake the `//` of a URL (`https://`) for one.
		const lineComment = line.search(/(^|[^:])\/\//);
		if (lineComment !== -1) {
			const at = line.indexOf('//', lineComment);
			line = line.slice(0, at);
		}
		const open = line.indexOf('/*');
		if (open !== -1) {
			const close = line.indexOf('*/', open + 2);
			if (close === -1) { inBlock = true; line = line.slice(0, open); }
			else { line = line.slice(0, open) + line.slice(close + 2); }
		}
		out.push(line);
	}
	return out.join('\n');
}

// Both `import 'x.js'` (side-effect) and `import { y } from 'x.js'` load the module.
const IMPORT_RE = /(?:^|\n)\s*import\s+(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const REGISTRAR_RE = /registerSingleton\s*\(\s*([A-Za-z_$][\w$]*)/g;

const relId = (abs) => path.relative(CONTRIB_ROOT, abs).replace(/\\/g, '/');
const files = [...walk(CONTRIB_ROOT)].filter((f) => !relId(f).startsWith('test/'));

/** module -> Set of imported modules (only edges that stay inside the vibeide contrib) */
const imports = new Map();
/** module -> [decorator names it registers] */
const registrars = new Map();

for (const file of files) {
	const src = stripComments(fs.readFileSync(file, 'utf8'));
	const targets = new Set();
	for (const m of src.matchAll(IMPORT_RE)) {
		const spec = m[1];
		if (!spec.startsWith('.')) {continue;}
		// Sources import compiled `.js` specifiers; resolve back to the `.ts` on disk.
		const resolved = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
		if (files.includes(resolved)) {targets.add(relId(resolved));}
	}
	imports.set(relId(file), targets);

	const decorators = [...src.matchAll(REGISTRAR_RE)].map((m) => m[1]);
	if (decorators.length > 0) {registrars.set(relId(file), decorators);}
}

// Entry points are PLURAL. `browser/vibeide.contribution.ts` is the main one, but not the only one:
// `vs/workbench/workbench.desktop.main.ts` imports `electron-browser/vibeDesktopNotificationService.js`
// directly, because a desktop-only implementation must not be pulled into the web bundle. Rooting the
// walk at the contribution alone reported that (correctly wired) service as unreachable.
//
// So: a root is any vibeide module imported from OUTSIDE the contrib. That models what the workbench
// actually loads, instead of guessing which file is "the" entry.
function findExternalRoots() {
	const roots = new Set([relId(ENTRY)]);
	const SRC_ROOT = path.resolve(process.cwd(), 'src');
	for (const file of walk(SRC_ROOT)) {
		if (file.startsWith(CONTRIB_ROOT + path.sep)) {continue;}
		let src;
		try { src = stripComments(fs.readFileSync(file, 'utf8')); } catch { continue; }
		for (const m of src.matchAll(IMPORT_RE)) {
			if (!m[1].startsWith('.')) {continue;}
			const resolved = path.resolve(path.dirname(file), m[1]).replace(/\.js$/, '.ts');
			if (files.includes(resolved)) {roots.add(relId(resolved));}
		}
	}
	return roots;
}

const ENTRY_ID = relId(ENTRY);
const reachable = new Set(findExternalRoots());
const queue = [...reachable];
while (queue.length > 0) {
	for (const next of imports.get(queue.pop()) ?? []) {
		if (!reachable.has(next)) {
			reachable.add(next);
			queue.push(next);
		}
	}
}

const unreachable = [...registrars.keys()].filter((id) => !reachable.has(id)).sort();

if (mode === '--check') {
	if (unreachable.length === 0) {
		console.log(`service registration ok (${registrars.size} registrar module(s), all reachable from ${ENTRY_ID}).`);
		process.exit(0);
	}
	console.error(`${unreachable.length} registrar module(s) unreachable from ${ENTRY_ID}:`);
	for (const id of unreachable) {
		console.error(`  ${id} — registers ${registrars.get(id).join(', ')}; nothing loads it, so the singleton never registers`);
	}
	console.error(`Fix: add a side-effect import (\`import './path.js';\`) to ${ENTRY_ID}.`);
	process.exit(1);
}

console.log(`registrar modules: ${registrars.size}, reachable from ${ENTRY_ID}: ${registrars.size - unreachable.length}`);
for (const [id, decorators] of [...registrars].sort()) {
	console.log(`  ${reachable.has(id) ? 'ok  ' : 'MISS'} ${id} — ${decorators.join(', ')}`);
}
