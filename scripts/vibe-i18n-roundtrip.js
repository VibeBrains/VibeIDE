#!/usr/bin/env node
/**
 * vibe-i18n-roundtrip — VibeIDE i18n round-trip validator
 *
 * Usage:
 *   node scripts/vibe-i18n-roundtrip.js [--out-dir <path>] [--strict] [--json]
 *
 * Reads vibeide.nls.metadata.json + vibeide.nls.<locale>.json from <out-dir>
 * (default: ./out/) and reports orphan keys, placeholder mismatches, and
 * empty translations.
 *
 * Exit codes:
 *   0  no issues found
 *   1  issues found (only when --strict is passed, otherwise informational)
 *
 * (roadmap §L504 — File-IO walker for i18nRoundtripChecker)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { checkI18nRoundtrip, partitionLocaleForOrphanMove } = require('./lib/i18n-roundtrip-checker.cjs');

const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const JSON_OUT = args.includes('--json');
const MOVE_ORPHANS = args.includes('--move-orphans');

let outDir = path.join(process.cwd(), 'out');
const outDirIdx = args.indexOf('--out-dir');
if (outDirIdx !== -1 && args[outDirIdx + 1]) {
	outDir = path.resolve(args[outDirIdx + 1]);
}

// ── Load metadata ──────────────────────────────────────────────────────────

const metadataPath = path.join(outDir, 'vibeide.nls.metadata.json');
if (!fs.existsSync(metadataPath)) {
	console.error(`[vibe-i18n-roundtrip] metadata file not found: ${metadataPath}`);
	console.error(`Run 'npm run nls-extract:vibeide' first to generate it.`);
	process.exit(1);
}

const rawMeta = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
const metadataEnglish = new Map();
for (const [_module, moduleData] of Object.entries(rawMeta)) {
	if (moduleData && Array.isArray(moduleData.keys) && Array.isArray(moduleData.messages)) {
		for (let i = 0; i < moduleData.keys.length; i++) {
			const key = moduleData.keys[i];
			const message = moduleData.messages[i];
			if (typeof key === 'string' && typeof message === 'string') {
				metadataEnglish.set(key, message);
			}
		}
	}
}

if (metadataEnglish.size === 0) {
	console.error(`[vibe-i18n-roundtrip] No keys found in metadata. Check ${metadataPath}`);
	process.exit(1);
}

// ── Discover locale bundles ─────────────────────────────────────────────────

const localeBundles = new Map();
const localePattern = /^vibeide\.nls\.([a-z]{2}(?:-[a-zA-Z]{2,8})*)\.json$/;

for (const file of fs.readdirSync(outDir)) {
	const match = file.match(localePattern);
	if (!match) continue;
	const localeTag = match[1];
	const bundlePath = path.join(outDir, file);
	try {
		const raw = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));
		localeBundles.set(localeTag, new Map(Object.entries(raw)));
	} catch (err) {
		console.warn(`[vibe-i18n-roundtrip] Could not parse ${bundlePath}: ${err.message}`);
	}
}

if (localeBundles.size === 0) {
	console.log(`[vibe-i18n-roundtrip] No locale bundles found in ${outDir} — nothing to check.`);
	process.exit(0);
}

// ── Run check ──────────────────────────────────────────────────────────────

const result = checkI18nRoundtrip({ metadataEnglish, localeBundles });

if (JSON_OUT) {
	console.log(JSON.stringify({ metadataKeys: metadataEnglish.size, ...result }, null, 2));
	process.exit(STRICT && result.stats.totalIssues > 0 ? 1 : 0);
}

// ── Markdown output ─────────────────────────────────────────────────────────

console.log(`\n## i18n Round-trip Report\n`);
console.log(`Metadata keys: **${metadataEnglish.size}**`);
console.log(`Locale bundles: **${localeBundles.size}** (${[...localeBundles.keys()].join(', ')})`);
console.log(`Total issues: **${result.stats.totalIssues}**\n`);

if (result.stats.totalIssues === 0) {
	console.log('✅ No round-trip issues found.');
} else {
	const byCode = new Map();
	for (const issue of result.issues) {
		const list = byCode.get(issue.code) ?? [];
		list.push(issue);
		byCode.set(issue.code, list);
	}

	for (const [code, issues] of byCode) {
		console.log(`### ${code} (${issues.length})\n`);
		const preview = issues.slice(0, 20);
		for (const issue of preview) {
			const detail = issue.detail ? ` — ${issue.detail}` : '';
			console.log(`- \`${issue.localeTag}\` / \`${issue.key}\`${detail}`);
		}
		if (issues.length > 20) console.log(`- … and ${issues.length - 20} more`);
		console.log();
	}
}

// ── Per-locale stats ────────────────────────────────────────────────────────

console.log('### Per-locale issue counts\n');
for (const [locale, count] of Object.entries(result.stats.perLocale).sort()) {
	const icon = count === 0 ? '✅' : '⚠️';
	console.log(`${icon} \`${locale}\`: ${count} issue(s)`);
}

// ── Orphan move ─────────────────────────────────────────────────────────────

if (MOVE_ORPHANS) {
	for (const [localeTag, bundle] of localeBundles) {
		const { keep, orphans } = partitionLocaleForOrphanMove(bundle, metadataEnglish);
		if (orphans.size === 0) continue;

		const bundleFile = path.join(outDir, `vibeide.nls.${localeTag}.json`);
		const orphansFile = path.join(outDir, `vibeide.nls.${localeTag}._orphans.json`);

		fs.writeFileSync(bundleFile, JSON.stringify(Object.fromEntries(keep), null, '\t'), 'utf-8');
		fs.writeFileSync(orphansFile, JSON.stringify(Object.fromEntries(orphans), null, '\t'), 'utf-8');
		console.log(`\nMoved ${orphans.size} orphan(s) from ${localeTag} → ${path.basename(orphansFile)}`);
	}
}

process.exit(STRICT && result.stats.totalIssues > 0 ? 1 : 0);
