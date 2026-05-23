#!/usr/bin/env node
// Roadmap V.0 prevention — Settings orphans / dead-registrations detector.
//
// Scans `src/vs/workbench/contrib/vibeide/**/*.ts` for:
//   - Reads:  `getValue(?:<T>)?\s*\(\s*['"]vibeide\.X['"]`
//   - Writes: `updateValue\s*\(\s*['"]vibeide\.X['"]`
//   - Affects: `affectsConfiguration\s*\(\s*['"]vibeide\.X['"]`
//
// Cross-references against keys registered in *GlobalSettingsConfiguration*.ts
// (matched by regex `['"]vibeide\.X['"]\s*:\s*\{` inside `properties` block).
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
			if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === '.build') continue;
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
	const isConfigFile = /GlobalSettingsConfiguration|SettingsConfiguration/.test(path.basename(file));

	if (isConfigFile) {
		for (const m of content.matchAll(REG_KEY_RE)) {
			const key = m[1];
			registrations.add(key);
			if (!fileOfRegistration.has(key)) fileOfRegistration.set(key, file);
		}
	}

	// Read patterns work on any source file
	for (const m of content.matchAll(READ_RE)) {
		const key = m[1];
		reads.add(key);
		if (!fileOfRead.has(key)) fileOfRead.set(key, `${file}:${(content.slice(0, m.index ?? 0).match(/\n/g) ?? []).length + 1}`);
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
const orphanReads = [...reads].filter(k => !registrations.has(k) && !isExemptByPrefix(k)).sort();
const deadRegs = [...registrations].filter(k => !reads.has(k) && !isExemptByPrefix(k)).sort();

const KNOWN_DYNAMIC_PREFIXES = ['vibeide.modelQuirks.', 'vibeide.modelOverrides.'];
const filteredOrphans = orphanReads.filter(k => !KNOWN_DYNAMIC_PREFIXES.some(p => k.startsWith(p)));

let exitCode = 0;
if (filteredOrphans.length > 0) {
	exitCode = 1;
	console.error(`\n${filteredOrphans.length} orphan read(s) — read in code, NOT registered in *GlobalSettingsConfiguration*.ts:`);
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
