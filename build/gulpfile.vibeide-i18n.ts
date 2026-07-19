/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Gulp tasks for VibeIDE i18n / Language Pack pipeline.
 *
 * Tasks:
 *   extract-vibeide-locale-strings  — scan src/vs/workbench/contrib/vibeide/**
 *       for localize() / localize2() calls and write out/nls/vibeide.nls.json
 *       (key → English default). Also writes out/nls/vibeide.nls.keys.json
 *       (ordered key list, mirrors VS Code's NLS metadata format).
 *
 *   build-vibeide-language-packs    — for each locale bundle present under
 *       out/nls/vibeide.nls.<locale>.json, assemble a VSIX directory and
 *       zip it to out/language-packs/vibeide-language-pack-<locale>-<ver>.vsix.
 *       Requires product.json:vibeVersion. Blocked on real translations; the
 *       task succeeds with zero VSIX files when no locale bundles exist.
 *
 * Pre-build hook in release-windows.ps1:
 *   Gulp "extract-vibeide-locale-strings"
 *   (build-vibeide-language-packs runs only when locale bundles exist)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import gulp from 'gulp';
import fancyLog from 'fancy-log';
import ansiColors from 'ansi-colors';
import * as task from './lib/task.ts';
import { partitionPathsByExclusion, type I18nExclusionReason } from '../src/vs/workbench/contrib/vibeide/common/i18nExtractionPolicy.ts';
import { buildMetadataContextEntry, type MetadataContextInput } from '../src/vs/workbench/contrib/vibeide/common/i18nMetadataContext.ts';

const REPO_ROOT = path.join(import.meta.dirname, '..');
const VIBE_SRC = path.join(REPO_ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
const NLS_OUT_DIR = path.join(REPO_ROOT, 'out', 'nls');
const LANG_PACK_OUT = path.join(REPO_ROOT, 'out', 'language-packs');

function log(msg: string): void {
	fancyLog(ansiColors.cyan('[vibeide-i18n]'), msg);
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function walkTs(dir: string, acc: string[] = []): string[] {
	if (!fs.existsSync(dir)) { return acc; }
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === 'node_modules' || ent.name === 'out' || ent.name === 'react') { continue; }
			walkTs(p, acc);
		} else if (/\.tsx?$/.test(ent.name) && !/\.test\.tsx?$/.test(ent.name)) {
			acc.push(p);
		}
	}
	return acc;
}

interface NlsEntry {
	key: string;
	message: string;
	filePath: string;
	lineNumber: number;
	snippet: string;
}

const SNIPPET_CONTEXT_LINES = 1;

/** Extract all localize(key, message) and localize2(key, message) call pairs. */
function extractLocalizeEntries(srcRoot: string): { entries: NlsEntry[]; excluded: ReadonlyArray<{ path: string; reason: I18nExclusionReason }> } {
	const callRe = /\blocalize2?\s*\(\s*(['"])((?:\\.|(?!\1).)*?)\1\s*,\s*(['"])((?:\\.|(?!\3).)*?)\3/g;
	const entries: NlsEntry[] = [];
	const seenKeys = new Set<string>();

	const absFiles = walkTs(srcRoot);
	const relFiles = absFiles.map(p => path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
	const partition = partitionPathsByExclusion(relFiles);
	const includedAbs = partition.included.map(rel => path.resolve(REPO_ROOT, rel));

	for (const file of includedAbs) {
		const text = fs.readFileSync(file, 'utf-8');
		const lines = text.split(/\r?\n/);
		const lineStartOffsets: number[] = [0];
		for (let i = 0; i < lines.length; i++) {
			lineStartOffsets.push(lineStartOffsets[i] + lines[i].length + 1);
		}
		const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
		callRe.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = callRe.exec(text)) !== null) {
			const key = m[2];
			const msg = m[4];
			if (seenKeys.has(key)) { continue; }
			seenKeys.add(key);
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
			entries.push({ key, message: msg, filePath: rel, lineNumber, snippet });
		}
	}
	return { entries, excluded: partition.excluded };
}

// --------------------------------------------------------------------------
// Task: extract-vibeide-locale-strings
// --------------------------------------------------------------------------

export const extractVibeideLocaleStringsTask = task.define('extract-vibeide-locale-strings', async () => {
	log(`Scanning ${path.relative(REPO_ROOT, VIBE_SRC)} for localize() calls...`);

	const { entries, excluded } = extractLocalizeEntries(VIBE_SRC);
	log(`Found ${entries.length} unique keys.`);
	if (excluded.length > 0) {
		const byReason = new Map<I18nExclusionReason, number>();
		for (const ex of excluded) {
			byReason.set(ex.reason, (byReason.get(ex.reason) ?? 0) + 1);
		}
		const reasonSummary = [...byReason.entries()].map(([r, n]) => `${r}=${n}`).join(', ');
		log(`Excluded ${excluded.length} paths by i18nExtractionPolicy: ${reasonSummary}`);
	}

	fs.mkdirSync(NLS_OUT_DIR, { recursive: true });

	// vibeide.nls.json: key → English default message
	const nlsMap: Record<string, string> = {};
	for (const e of entries) { nlsMap[e.key] = e.message; }
	const nlsJsonPath = path.join(NLS_OUT_DIR, 'vibeide.nls.json');
	fs.writeFileSync(nlsJsonPath, JSON.stringify(nlsMap, null, '\t') + '\n', 'utf-8');
	log(`Wrote ${path.relative(REPO_ROOT, nlsJsonPath)} (${entries.length} keys)`);

	// vibeide.nls.keys.json: ordered key array (matches VS Code NLS metadata)
	const keysJsonPath = path.join(NLS_OUT_DIR, 'vibeide.nls.keys.json');
	fs.writeFileSync(keysJsonPath, JSON.stringify(entries.map(e => e.key), null, '\t') + '\n', 'utf-8');
	log(`Wrote ${path.relative(REPO_ROOT, keysJsonPath)}`);

	// vibeide.nls.metadata.json: key → { english, context: "<file:line>\n<snippet>" }
	// Drives Crowdin context field for translators (roadmap §511).
	const metadataMap: Record<string, { english: string; context: string }> = {};
	for (const e of entries) {
		const input: MetadataContextInput = {
			key: e.key,
			englishSource: e.message,
			sourceContext: {
				filePath: e.filePath,
				lineNumber: e.lineNumber,
				snippet: e.snippet,
			},
		};
		metadataMap[e.key] = buildMetadataContextEntry(input);
	}
	const metadataPath = path.join(NLS_OUT_DIR, 'vibeide.nls.metadata.json');
	fs.writeFileSync(metadataPath, JSON.stringify(metadataMap, null, '\t') + '\n', 'utf-8');
	log(`Wrote ${path.relative(REPO_ROOT, metadataPath)} (with translator context)`);
});

gulp.task(extractVibeideLocaleStringsTask);

// --------------------------------------------------------------------------
// Task: build-vibeide-language-packs
// --------------------------------------------------------------------------

function readProductVersion(): string {
	const productPath = path.join(REPO_ROOT, 'product.json');
	const product = JSON.parse(fs.readFileSync(productPath, 'utf-8'));
	return String(product.vibeVersion ?? '0.0.0');
}

/** Minimal VSIX package.json manifest for a VibeIDE language pack extension. */
function buildVsixManifest(locale: string, localeDisplay: string, vibeVersion: string): object {
	return {
		name: `vibeide-language-pack-${locale}`,
		displayName: `VibeIDE Language Pack (${localeDisplay})`,
		description: `VibeIDE UI strings for locale ${locale}.`,
		version: vibeVersion,
		publisher: 'vibeide',
		engines: { vscode: '^1.90.0' },
		categories: ['Language Packs'],
		contributes: {
			localizations: [
				{
					languageId: locale,
					languageName: localeDisplay,
					localizedLanguageName: localeDisplay,
					translations: [
						{
							id: 'vibeide',
							path: `./translations/vibeide.nls.${locale}.json`,
						},
					],
				},
			],
		},
	};
}

export const buildVibeideLanguagePacksTask = task.define('build-vibeide-language-packs', async () => {
	const vibeVersion = readProductVersion();
	log(`Building language packs for VibeIDE ${vibeVersion}...`);

	if (!fs.existsSync(NLS_OUT_DIR)) {
		log('No out/nls/ directory found. Run extract-vibeide-locale-strings first.');
		return;
	}

	// Find all vibeide.nls.<locale>.json files in out/nls/
	const localeFiles = fs.readdirSync(NLS_OUT_DIR)
		.filter(n => /^vibeide\.nls\.[a-zA-Z0-9_-]+\.json$/.test(n) && n !== 'vibeide.nls.json');

	if (localeFiles.length === 0) {
		log('No locale bundles found under out/nls/ — skipping VSIX packaging.');
		log('To add translations: create out/nls/vibeide.nls.<locale>.json with key→translated-string map.');
		return;
	}

	fs.mkdirSync(LANG_PACK_OUT, { recursive: true });

	for (const localeFile of localeFiles) {
		const m = localeFile.match(/^vibeide\.nls\.([a-zA-Z0-9_-]+)\.json$/);
		if (!m) { continue; }
		const locale = m[1];
		const localeDisplay = locale; // caller can extend with a display-name map

		log(`Packaging language pack for locale: ${locale}`);

		const bundlePath = path.join(NLS_OUT_DIR, localeFile);
		const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf-8'));

		// Build VSIX directory structure
		const vsixDir = path.join(LANG_PACK_OUT, `vibeide-language-pack-${locale}`);
		const translationsDir = path.join(vsixDir, 'translations');
		fs.mkdirSync(translationsDir, { recursive: true });

		// package.json
		const manifest = buildVsixManifest(locale, localeDisplay, vibeVersion);
		fs.writeFileSync(path.join(vsixDir, 'package.json'), JSON.stringify(manifest, null, '\t') + '\n', 'utf-8');

		// Translation bundle
		fs.writeFileSync(
			path.join(translationsDir, `vibeide.nls.${locale}.json`),
			JSON.stringify(bundle, null, '\t') + '\n',
			'utf-8',
		);

		// Zip into VSIX using PowerShell Compress-Archive (Windows) or zip (Unix)
		const vsixName = `vibeide-language-pack-${locale}-${vibeVersion}.vsix`;
		const vsixPath = path.join(LANG_PACK_OUT, vsixName);
		if (fs.existsSync(vsixPath)) { fs.unlinkSync(vsixPath); }

		try {
			if (process.platform === 'win32') {
				execSync(
					`powershell -Command "Compress-Archive -Path '${vsixDir}\\*' -DestinationPath '${vsixPath}'"`,
					{ stdio: 'pipe' },
				);
			} else {
				execSync(`cd "${vsixDir}" && zip -r "${vsixPath}" .`, { stdio: 'pipe', shell: '/bin/bash' });
			}
			log(`Created ${vsixName}`);
		} catch (err) {
			fancyLog(ansiColors.yellow('[vibeide-i18n]'), `VSIX zip failed for ${locale}: ${(err as Error).message}`);
		}
	}

	log('Language pack build complete.');
});

gulp.task(buildVibeideLanguagePacksTask);

// Convenience combined task
export const vibeideI18nTask = task.define(
	'vibeide-i18n',
	task.series(extractVibeideLocaleStringsTask, buildVibeideLanguagePacksTask),
);
gulp.task(vibeideI18nTask);
