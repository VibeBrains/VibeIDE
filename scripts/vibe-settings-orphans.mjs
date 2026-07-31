#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Roadmap V.0 prevention — Settings orphans / dead-registrations detector.
//
// Scans `src/vs/workbench/contrib/vibeide/**/*.ts` for:
//   - Reads:  `getValue(?:<T>)?\s*\(\s*['"]vibeide\.X['"]`
//   - Writes: `updateValue\s*\(\s*['"]vibeide\.X['"]`
//   - Affects: `affectsConfiguration\s*\(\s*['"]vibeide\.X['"]`
//
// Cross-references against keys registered in ANY file that calls
// `registerConfiguration(` (matched by regex `['"]vibeide\.X['"]\s*:\s*\{`
// inside its `properties` block). Detection is content-based, not name-based:
// settings live in ~48 registrar files (e.g. `vibeAgentBehaviorConfiguration.ts`,
// per-service `*Configuration.ts`), not only `*GlobalSettingsConfiguration*.ts`.
//
// Reports:
//   - **Orphan reads**: code reads a key that's not registered → bug class V.0.
//   - **Dead registrations**: key registered but never read/affected → cleanup hint.
//
// **Known limitation**: keys read via `fs.watch(settings.json) + JSON.parse`
// pattern (e.g. watchdog hot-reload) bypass `getValue`/`affectsConfiguration`
// and appear as dead-registrations. Use the exemption list below for those.
//
// Exit 0 = clean (no orphan reads); exit 1 = orphan reads found.
// Dead-registrations always soft-warning (informational).

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const codeRoot = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
if (!fs.existsSync(codeRoot)) {
	console.error(`directory not found: ${codeRoot}`);
	process.exit(2);
}

function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === '.build') {continue;}
			yield* walk(full);
		} else if (entry.isFile() && full.endsWith('.ts')) {
			yield full;
		}
	}
}

const READ_RE = /\b(?:getValue|onDidChangeConfiguration\s*\(\s*\([^)]*\)\s*=>\s*[^.]+\.affectsConfiguration|affectsConfiguration|updateValue)\s*(?:<[^>]+>)?\s*\(\s*['"`](vibeide\.[^'"`]+)['"`]/g;
const SIMPLE_KEY_RE = /['"`](vibeide\.[a-zA-Z_$][\w$.]*)['"`]/g;
const REG_KEY_RE = /['"`](vibeide\.[a-zA-Z_$][\w$.]*)['"`]\s*:\s*\{/g;

const reads = new Set();
const registrations = new Set();
const fileOfRead = new Map(); // key → first file path
const fileOfRegistration = new Map();

for (const file of walk(codeRoot)) {
	const content = fs.readFileSync(file, 'utf8');
	// A file is a registration source if it actually calls `registerConfiguration(` —
	// not by filename. The `'vibeide.X': {` extraction below only fires inside such
	// files, so a file merely mentioning the call (comment/string) with no schema
	// contributes zero registrations and is harmless.
	const isConfigFile = /\bregisterConfiguration\s*\(/.test(content);

	if (isConfigFile) {
		for (const m of content.matchAll(REG_KEY_RE)) {
			const key = m[1];
			registrations.add(key);
			if (!fileOfRegistration.has(key)) {fileOfRegistration.set(key, file);}
		}
	}

	// Read patterns work on any source file
	for (const m of content.matchAll(READ_RE)) {
		const key = m[1];
		reads.add(key);
		if (!fileOfRead.has(key)) {fileOfRead.set(key, `${file}:${(content.slice(0, m.index ?? 0).match(/\n/g) ?? []).length + 1}`);}
	}
}

// Prefixes for keys read through non-standard mechanisms (fs.watch + JSON
// parse, MCP catalog refresh, etc.). Adding a prefix here exempts ALL keys
// under it from both orphan-read AND dead-registration analysis — used
// when the read pattern doesn't go through `getValue`/`affectsConfiguration`.
const READ_VIA_NON_STANDARD_PREFIXES = [
	'vibeide.modelQuirks.',
	'vibeide.modelOverrides.',
	'vibeide.diagnostics.idleWatchdog.',
];
const isExemptByPrefix = (k) => READ_VIA_NON_STANDARD_PREFIXES.some(p => k.startsWith(p));
// Section read: code reads a parent key `vibeide.X` (the whole section object) whose
// leaf keys `vibeide.X.*` ARE registered — a valid pattern, not an orphan.
const isSectionRead = (k) => [...registrations].some(r => r.startsWith(`${k}.`));
const orphanReads = [...reads].filter(k => !registrations.has(k) && !isSectionRead(k) && !isExemptByPrefix(k)).sort();
const deadRegs = [...registrations].filter(k => !reads.has(k) && !isExemptByPrefix(k)).sort();

const KNOWN_DYNAMIC_PREFIXES = ['vibeide.modelQuirks.', 'vibeide.modelOverrides.'];
const filteredOrphans = orphanReads.filter(k => !KNOWN_DYNAMIC_PREFIXES.some(p => k.startsWith(p)));

let exitCode = 0;
if (filteredOrphans.length > 0) {
	exitCode = 1;
	console.error(`\n${filteredOrphans.length} orphan read(s) — read in code, NOT registered in any registerConfiguration() call:`);
	for (const key of filteredOrphans) {
		console.error(`  ${key}  (first seen: ${fileOfRead.get(key)})`);
	}
}

if (deadRegs.length > 0) {
	// Soft warning (doesn't fail CI) — dead registrations are cleanup hint, not bug.
	console.log(`\n${deadRegs.length} dead registration(s) — registered but never read (soft warning):`);
	for (const key of deadRegs) {
		console.log(`  ${key}  (registered in: ${path.relative(repoRoot, fileOfRegistration.get(key))})`);
	}
}

if (exitCode === 0 && deadRegs.length === 0) {
	console.log(`Settings audit clean: ${reads.size} reads ↔ ${registrations.size} registrations.`);
}
process.exit(exitCode);
