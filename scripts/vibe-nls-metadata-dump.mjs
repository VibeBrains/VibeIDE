#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * vibe-nls-metadata-dump — per-locale Crowdin-context dumper.
 *
 * For each NLS key extracted from `src/vs/workbench/contrib/vibeide/**`, walks
 * the source tree once, captures file:line + 2-3 lines of snippet, and writes
 *   out/nls/vibeide.nls.metadata.<locale>.json
 * with shape  `{ [key]: { english, localized, context } }`.
 *
 * - english:    the original string passed to `localize()/localize2()`.
 * - localized:  the translation from out/nls/vibeide.nls.<locale>.json (or null
 *               when the key is missing from that locale bundle).
 * - context:    Crowdin-compatible context string built via
 *               `buildMetadataContextEntry` (file:line\n<snippet>).
 *
 * Honours `common/i18nExtractionPolicy.ts` exclusion rules — skill-prompt
 * templates, persona templates, workflow YAML, test fixtures, snapshots,
 * build artefacts and docs-only Markdown never produce keys here. Mirrors
 * the gulp `extract-vibeide-locale-strings` task; running it standalone is
 * useful when you only want to refresh per-locale metadata without a full
 * gulp build (e.g. as a pre-Crowdin export step).
 *
 * Usage:
 *   node scripts/vibe-nls-metadata-dump.mjs                       # all locales found in out/nls/
 *   node scripts/vibe-nls-metadata-dump.mjs --locale ru           # one locale
 *   node scripts/vibe-nls-metadata-dump.mjs --out-dir build/nls   # different bundle root
 *   node scripts/vibe-nls-metadata-dump.mjs --english-only        # also write vibeide.nls.metadata.json (no locale)
 *
 * (roadmap §L511 — file-IO walker for i18nMetadataContext)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VIBE_SRC = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
const DEFAULT_OUT_DIR = path.join(ROOT, 'out', 'nls');

const require = createRequire(import.meta.url);
const { buildMetadataContextEntry } = require('./lib/i18n-metadata-context.cjs');

// MUST stay in sync with RULES in src/vs/workbench/contrib/vibeide/common/i18nExtractionPolicy.ts.
// Same mirror used by scan-vibeide-i18n.mjs — keeps lint + extract + dump symmetric.
const I18N_EXCLUSION_RULES = [
	{ reason: 'skill-prompt-template', test: (p) => /(\.vibe[/\\])?skills[/\\][^/\\]+[/\\]SKILL\.md$/i.test(p) || /\.vibe[/\\]prompts[/\\][^/\\]+\.md$/i.test(p) },
	{ reason: 'persona-template', test: (p) => /\.vibe[/\\]personas[/\\][^/\\]+[/\\]persona\.md$/i.test(p) },
	{ reason: 'workflow-yaml', test: (p) => /\.vibe[/\\]workflows[/\\][^/\\]+\.ya?ml$/i.test(p) },
	{ reason: 'react-out-bundle', test: (p) => /[\\/]react[\\/]out[\\/]/i.test(p) },
	{ reason: 'test-fixture', test: (p) => /[\\/]test[\\/].*\.(test|fixture)\.(ts|tsx|js)$/i.test(p) },
	{ reason: 'snapshot-file', test: (p) => /\.snap$|__snapshots__[\\/]/i.test(p) },
	{ reason: 'build-artifact', test: (p) => /^(out[\\/]|\.build[\\/]|dist[\\/]|build[\\/]lib[\\/]|node_modules[\\/])/i.test(p) },
	{ reason: 'docs-only', test: (p) => /^docs[\\/].*\.md$/i.test(p) || /^references[\\/].*\.md$/i.test(p) },
	{ reason: 'community-pack-content', test: (p) => /\.vibe[/\\](skills|commands)[/\\].*[/\\](content|README)\.md$/i.test(p) },
];

function isExcluded(workspaceRelativePath) {
	const normalised = workspaceRelativePath.replace(/^[/\\]+/, '');
	for (const rule of I18N_EXCLUSION_RULES) {
		if (rule.test(normalised)) { return rule.reason; }
	}
	return null;
}

function parseArgs(argv) {
	const args = { locale: null, outDir: DEFAULT_OUT_DIR, englishOnly: false, help: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--locale' && argv[i + 1]) { args.locale = argv[++i]; continue; }
		if (a === '--out-dir' && argv[i + 1]) { args.outDir = path.resolve(argv[++i]); continue; }
		if (a === '--english-only') { args.englishOnly = true; continue; }
		if (a === '--help' || a === '-h') { args.help = true; continue; }
	}
	return args;
}

const SNIPPET_CONTEXT_LINES = 1;

function walkTs(dir, acc = []) {
	if (!fs.existsSync(dir)) { return acc; }
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'react') { continue; }
			walkTs(p, acc);
			continue;
		}
		if (!/\.tsx?$/.test(ent.name)) { continue; }
		if (/\.test\.tsx?$/.test(ent.name)) { continue; }
		const rel = path.relative(ROOT, p).replace(/\\/g, '/');
		if (isExcluded(rel)) { continue; }
		acc.push(p);
	}
	return acc;
}

function extractEntries(srcRoot) {
	const callRe = /\blocalize2?\s*\(\s*(['"])((?:\\.|(?!\1).)*?)\1\s*,\s*(['"])((?:\\.|(?!\3).)*?)\3/g;
	const entries = [];
	const seen = new Set();

	for (const file of walkTs(srcRoot)) {
		const text = fs.readFileSync(file, 'utf-8');
		const lines = text.split(/\r?\n/);
		const lineStartOffsets = [0];
		for (let i = 0; i < lines.length; i++) {
			lineStartOffsets.push(lineStartOffsets[i] + lines[i].length + 1);
		}
		const rel = path.relative(ROOT, file).replace(/\\/g, '/');
		callRe.lastIndex = 0;
		let m;
		while ((m = callRe.exec(text)) !== null) {
			const key = m[2];
			const msg = m[4];
			if (seen.has(key)) { continue; }
			seen.add(key);
			const offset = m.index;
			let lineNumber = 1;
			for (let i = 0; i < lineStartOffsets.length - 1; i++) {
				if (offset >= lineStartOffsets[i] && offset < lineStartOffsets[i + 1]) {
					lineNumber = i + 1;
					break;
				}
			}
			const startLine = Math.max(0, lineNumber - 1 - SNIPPET_CONTEXT_LINES);
			const endLine = Math.min(lines.length, lineNumber + SNIPPET_CONTEXT_LINES);
			const snippet = lines.slice(startLine, endLine).join('\n');
			entries.push({ key, english: msg, filePath: rel, lineNumber, snippet });
		}
	}
	return entries;
}

function readLocaleBundle(outDir, locale) {
	const p = path.join(outDir, `vibeide.nls.${locale}.json`);
	if (!fs.existsSync(p)) { return null; }
	try {
		const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { return parsed; }
		return null;
	} catch {
		return null;
	}
}

function discoverLocales(outDir) {
	if (!fs.existsSync(outDir)) { return []; }
	const locales = [];
	for (const name of fs.readdirSync(outDir)) {
		// Strict shape: vibeide.nls.<locale>.json — reject our own metadata
		// outputs (vibeide.nls.metadata.json, vibeide.nls.metadata.<locale>.json,
		// vibeide.nls.keys.json) so the dumper never treats them as locale bundles.
		const m = name.match(/^vibeide\.nls\.([a-zA-Z0-9_-]+)\.json$/);
		if (!m) { continue; }
		const tag = m[1];
		if (tag === 'metadata' || tag === 'keys') { continue; }
		if (name === 'vibeide.nls.json') { continue; }
		locales.push(tag);
	}
	return locales.sort();
}

function writeMetadataFile(outPath, entries, localeMap) {
	const map = {};
	for (const e of entries) {
		const built = buildMetadataContextEntry({
			key: e.key,
			englishSource: e.english,
			sourceContext: { filePath: e.filePath, lineNumber: e.lineNumber, snippet: e.snippet },
		});
		const out = {
			english: built.english,
			context: built.context,
		};
		if (localeMap) {
			out.localized = Object.prototype.hasOwnProperty.call(localeMap, e.key) ? localeMap[e.key] : null;
		}
		map[e.key] = out;
	}
	fs.mkdirSync(path.dirname(outPath), { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify(map, null, '\t') + '\n', 'utf-8');
}

function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		console.log(`Usage: node scripts/vibe-nls-metadata-dump.mjs [--locale <tag>] [--out-dir <path>] [--english-only]`);
		return;
	}

	console.log(`[vibe-nls-metadata-dump] root: ${path.relative(ROOT, VIBE_SRC) || '.'}`);
	const entries = extractEntries(VIBE_SRC);
	console.log(`  unique keys: ${entries.length}`);

	if (entries.length === 0) {
		console.log('  no keys found — nothing to dump.');
		return;
	}

	if (args.englishOnly) {
		const outPath = path.join(args.outDir, 'vibeide.nls.metadata.json');
		writeMetadataFile(outPath, entries, null);
		console.log(`  wrote ${path.relative(ROOT, outPath)} (english-only, ${entries.length} keys)`);
		return;
	}

	const locales = args.locale ? [args.locale] : discoverLocales(args.outDir);
	if (locales.length === 0) {
		console.log(`  no locale bundles found under ${path.relative(ROOT, args.outDir) || '.'} — pass --english-only to emit metadata anyway.`);
		return;
	}

	let written = 0;
	let skipped = 0;
	for (const locale of locales) {
		const bundle = readLocaleBundle(args.outDir, locale);
		if (!bundle) {
			console.log(`  [${locale}] bundle missing — skipped.`);
			skipped++;
			continue;
		}
		const outPath = path.join(args.outDir, `vibeide.nls.metadata.${locale}.json`);
		writeMetadataFile(outPath, entries, bundle);
		const translated = entries.filter((e) => Object.prototype.hasOwnProperty.call(bundle, e.key)).length;
		console.log(`  [${locale}] wrote ${path.relative(ROOT, outPath)} — ${translated}/${entries.length} translated`);
		written++;
	}
	console.log(`[vibe-nls-metadata-dump] done — ${written} locale file(s) written, ${skipped} skipped.`);
}

// `await import()` guard so this module can also be imported by other tooling
// without executing the CLI side-effect.
const invokedAsCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsCli) {
	main();
}

export { extractEntries, writeMetadataFile, discoverLocales, isExcluded };
