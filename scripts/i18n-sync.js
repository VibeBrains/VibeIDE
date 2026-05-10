#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vibe i18n sync (roadmap §497) — fills `[NEEDS_TRANSLATION]` placeholders
 * for new metadata keys and rotates orphan translations to `_orphans.json`.
 *
 * Pure helpers consumed (file IO is here):
 *   - findKeysNeedingPlaceholder (i18nGracePeriodPolicy.ts) — keys present in
 *     metadata but absent in the locale snapshot.
 *   - partitionLocaleForOrphanMove (i18nRoundtripChecker.ts) — splits an
 *     existing bundle into {keep, orphan} when a metadata key disappears.
 *
 * Both helpers are TS modules — this script duplicates a small subset (set
 * partitioning + lookup) so the CI runner has zero deps. Marked
 * "MUST stay in sync" comments below.
 *
 * Usage:
 *   node scripts/i18n-sync.js                      # dry-run, prints actions
 *   node scripts/i18n-sync.js --apply              # writes locale bundle + _orphans.json
 *   node scripts/i18n-sync.js --locale ru          # default: ru
 *   node scripts/i18n-sync.js --metadata <path>    # default: out/nls.metadata.json
 *   node scripts/i18n-sync.js --bundle <path>      # default: out/vibeide.nls.<locale>.json
 *
 * The script gracefully skips when prerequisite files are missing — the i18n
 * pipeline is partially built (no language-pack VSIX yet, no compiled
 * metadata snapshot in this checkout); when those land, this CLI is ready.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function value(name, dflt) {
	const idx = args.indexOf(name);
	if (idx >= 0 && idx + 1 < args.length) { return args[idx + 1]; }
	return dflt;
}

const APPLY = flag('--apply');
const LOCALE = value('--locale', 'ru');
const METADATA_PATH = path.resolve(ROOT, value('--metadata', 'out/nls.metadata.json'));
const BUNDLE_PATH = path.resolve(ROOT, value('--bundle', `out/vibeide.nls.${LOCALE}.json`));
const ORPHANS_PATH = path.resolve(path.dirname(BUNDLE_PATH), `_orphans.${LOCALE}.json`);

function safeReadJson(filePath) {
	if (!fs.existsSync(filePath)) { return null; }
	try {
		return JSON.parse(fs.readFileSync(filePath, 'utf8'));
	} catch (e) {
		console.error(`i18n-sync: failed to parse ${filePath}: ${e.message}`);
		return null;
	}
}

// MUST stay in sync with `findKeysNeedingPlaceholder` in
// src/vs/workbench/contrib/vibeide/common/i18nGracePeriodPolicy.ts.
function findKeysNeedingPlaceholder(metadataKeys, headSnapshotKeys) {
	const out = [];
	for (const k of metadataKeys) {
		if (!headSnapshotKeys.has(k)) { out.push(k); }
	}
	out.sort();
	return out;
}

// MUST stay in sync with `partitionLocaleForOrphanMove` in
// src/vs/workbench/contrib/vibeide/common/i18nRoundtripChecker.ts.
function partitionLocaleForOrphanMove(bundle, metadataKeys) {
	const keep = {};
	const orphan = {};
	for (const [k, v] of Object.entries(bundle)) {
		if (metadataKeys.has(k)) { keep[k] = v; } else { orphan[k] = v; }
	}
	return { keep, orphan };
}

function main() {
	if (!fs.existsSync(METADATA_PATH)) {
		console.log(`[skipped: no metadata snapshot at ${path.relative(ROOT, METADATA_PATH)}]`);
		console.log('  Generate via the gulp `extract-vibeide-locale-strings` task once the i18n pipeline lands.');
		return;
	}

	const metadata = safeReadJson(METADATA_PATH);
	if (!metadata || typeof metadata !== 'object') {
		console.error('i18n-sync: metadata snapshot is not an object — aborting.');
		process.exit(2);
	}
	const metadataKeys = new Set(Object.keys(metadata));
	const bundle = safeReadJson(BUNDLE_PATH) ?? {};
	const headSnapshotKeys = new Set();
	const NEEDS_TRANSLATION = '[NEEDS_TRANSLATION]';
	for (const [k, v] of Object.entries(bundle)) {
		// Both real translations and existing placeholders count as "present"
		// — we only re-fill keys that are entirely missing from the bundle.
		if (typeof v === 'string' && v.length > 0) { headSnapshotKeys.add(k); }
	}

	const missingKeys = findKeysNeedingPlaceholder(metadataKeys, headSnapshotKeys);
	const { keep, orphan } = partitionLocaleForOrphanMove(bundle, metadataKeys);

	const placeholderInserts = {};
	for (const k of missingKeys) {
		const englishSrc = typeof metadata[k] === 'string' ? metadata[k] : '';
		placeholderInserts[k] = `${NEEDS_TRANSLATION} ${englishSrc}`.trimEnd();
	}

	const orphanCount = Object.keys(orphan).length;
	const newKeepBundle = { ...keep, ...placeholderInserts };

	console.log(`i18n-sync (locale=${LOCALE}, ${APPLY ? 'apply' : 'dry-run'}):`);
	console.log(`  metadata keys:        ${metadataKeys.size}`);
	console.log(`  current bundle keys:  ${Object.keys(bundle).length}`);
	console.log(`  placeholders to add:  ${missingKeys.length}`);
	console.log(`  orphans to rotate:    ${orphanCount}`);

	if (!APPLY) {
		console.log('Run again with --apply to write changes.');
		return;
	}

	fs.writeFileSync(BUNDLE_PATH, JSON.stringify(newKeepBundle, null, 2) + '\n', 'utf8');
	console.log(`  wrote: ${path.relative(ROOT, BUNDLE_PATH)}`);
	if (orphanCount > 0) {
		const existingOrphans = safeReadJson(ORPHANS_PATH) ?? {};
		const merged = { ...existingOrphans, ...orphan };
		fs.writeFileSync(ORPHANS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
		console.log(`  wrote: ${path.relative(ROOT, ORPHANS_PATH)} (+${orphanCount})`);
	}
}

main();
