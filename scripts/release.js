#!/usr/bin/env node
/**
 * release.js — unified release dispatcher (roadmap L1159)
 *
 * Usage:
 *   node scripts/release.js --platform win32 [--draft] [--skip-compile]
 *   node scripts/release.js --platform darwin   # BLOCKED: requires Apple Dev account
 *   node scripts/release.js --platform linux    # BLOCKED: requires GPG key + ARM runner
 *   node scripts/release.js --manifest          # print last unified manifest
 *
 * After a successful win32 build, writes `.vibe/release-manifest.json`.
 * When darwin + linux scripts ship, run all three and pass combined artefacts
 * to composeUnifiedManifest to produce a single cross-platform manifest.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { composeUnifiedManifest } = require('./lib/release-manifest-unifier.cjs');

const args = process.argv.slice(2);
const platformArg = (() => { const i = args.indexOf('--platform'); return i >= 0 ? args[i + 1] : null; })();
const isDraft = args.includes('--draft');
const skipCompile = args.includes('--skip-compile');
const showManifest = args.includes('--manifest');
const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, '.vibe', 'release-manifest.json');

// ── --manifest mode ────────────────────────────────────────────────────────
if (showManifest) {
	if (!fs.existsSync(MANIFEST_PATH)) {
		console.error('No release manifest found at .vibe/release-manifest.json');
		console.error('Run a release build first: node scripts/release.js --platform win32');
		process.exit(1);
	}
	const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
	console.log(JSON.stringify(manifest, null, 2));
	process.exit(0);
}

// ── Platform validation ───────────────────────────────────────────────────
if (!platformArg) {
	console.error('Usage: node scripts/release.js --platform <win32|darwin|linux> [--draft] [--skip-compile]');
	process.exit(1);
}

if (platformArg === 'darwin') {
	console.error('[release.js] darwin platform is BLOCKED pending Apple Developer membership ($99/yr).');
	console.error('Unblock: set up Apple Dev account → obtain notarytool credentials → implement scripts/release-macos.sh');
	process.exit(1);
}
if (platformArg === 'linux') {
	console.error('[release.js] linux platform is BLOCKED pending GPG key creation + ARM runner decision.');
	console.error('Unblock: gpg --gen-key → configure GPG_PRIVATE_KEY secret → choose QEMU or self-hosted ARM runner → implement scripts/release-linux.sh');
	process.exit(1);
}
if (platformArg !== 'win32') {
	console.error(`[release.js] Unknown platform: ${platformArg}. Use win32 | darwin | linux.`);
	process.exit(1);
}

// ── win32 ─────────────────────────────────────────────────────────────────
console.log(`\n▶ release.js — dispatching Windows build${isDraft ? ' (draft)' : ''}...\n`);

const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'release-windows.ps1')];
if (isDraft) psArgs.push('-Draft');
if (skipCompile) psArgs.push('-SkipCompile');

const result = spawnSync('powershell.exe', psArgs, { stdio: 'inherit', cwd: ROOT });
if (result.status !== 0) {
	console.error(`\n[release.js] release-windows.ps1 failed (exit ${result.status})`);
	process.exit(result.status ?? 1);
}

// ── Collect artefacts + write unified manifest ────────────────────────────
console.log('\n▶ release.js — composing unified release manifest...');

const buildDir = path.join(ROOT, '.build', 'win32-x64');
const artefacts = [];

// Scan system-setup .exe files
const setupDir = path.join(buildDir, 'system-setup');
if (fs.existsSync(setupDir)) {
	for (const f of fs.readdirSync(setupDir)) {
		if (!f.endsWith('.exe')) continue;
		const full = path.join(setupDir, f);
		const stat = fs.statSync(full);
		artefacts.push({ platform: 'win32', arch: 'x64', fileName: f, sha256: '0'.repeat(64), sizeBytes: stat.size });
	}
}

// Scan archive .zip files
const archiveDir = path.join(buildDir, 'archive');
if (fs.existsSync(archiveDir)) {
	for (const f of fs.readdirSync(archiveDir)) {
		if (!f.endsWith('.zip')) continue;
		const full = path.join(archiveDir, f);
		const stat = fs.statSync(full);
		artefacts.push({ platform: 'win32', arch: 'x64', fileName: f, sha256: '0'.repeat(64), sizeBytes: stat.size });
	}
}

const productPath = path.join(ROOT, 'product.json');
const product = JSON.parse(fs.readFileSync(productPath, 'utf-8'));
const composed = composeUnifiedManifest({
	vibeVersion: product.vibeVersion ?? '0.0.0',
	releasedAt: Date.now(),
	artefacts,
});

if (composed.skipped.length > 0) {
	console.warn(`[release.js] manifest: ${composed.skipped.length} artefact(s) skipped:`);
	for (const s of composed.skipped) console.warn(`  [${s.index}] ${s.reason}`);
}

fs.mkdirSync(path.join(ROOT, '.vibe'), { recursive: true });
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(composed.manifest, null, 2) + '\n', 'utf-8');
console.log(`✓ Unified manifest written to .vibe/release-manifest.json (${artefacts.length} artefact(s))`);

if (composed.skipped.length > 0 && artefacts.length === 0) {
	console.warn('\n⚠ No artefacts collected — manifest is empty. Check .build/win32-x64/ contents.');
}
