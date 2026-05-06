#!/usr/bin/env -S npx tsx
/*---------------------------------------------------------------------------------------------
 *  VibeIDE NLS Extraction Script
 *
 *  Rebuilds dev NLS index files expected to match **gulp nls()** (build/lib/nls.ts):
 *    out/nls.keys.json
 *    out/nls.messages.json
 *    out/nls.metadata.json
 *    out/nls.messages.js
 *
 *  Must stay aligned with the numeric indices embedded in compiled out/vs (and sibling) JS after
 *  `compile-client` (preserveEnglish: true). Otherwise localized UI shows wrong strings.
 *
 *  Usage:
 *    npx tsx scripts/vibe-nls-extract.ts [--out <dir>]
 *
 *  Implementation notes:
 *  - File order: absolute path localeCompare (same as gulp-sort defaultComparator on vinyl.path).
 *  - Per-file call discovery: `analyzeLocalizeCalls` from build/lib/nls-analysis.ts (same as nls.ts).
 *  - Do not skip vs test/ sources — they are compiled and included in gulp NLS order.
 *  - Skip only paths excluded by src/tsconfig.json (e.g. VibeIDE react sources).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { glob as fsGlob } from 'node:fs/promises';
import { fileURLToPath } from 'url';
import { analyzeLocalizeCalls, parseLocalizeKeyOrValue } from '../build/lib/nls-analysis.ts';

// ---------------------------------------------------------------------------
// Paths — works in both ESM and tsx CJS mode
// ---------------------------------------------------------------------------

const _scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(_scriptDir);
const SRC_DIR = path.join(REPO_ROOT, 'src');

function getArgValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const OUT_DIR = path.join(REPO_ROOT, getArgValue('--out') ?? 'out');

// ---------------------------------------------------------------------------
// tsconfig.json exclude (relative to src/) — must match compilation inputs
// ---------------------------------------------------------------------------

function shouldSkipTsSource(relPosix: string): boolean {
	if (!relPosix.endsWith('.ts') || relPosix.endsWith('.d.ts')) {
		return true;
	}
	// src/tsconfig.json — "exclude" (portable path check)
	if (relPosix.startsWith('vs/workbench/contrib/vibeide/browser/react/')) {
		return true;
	}
	return false;
}

function nlsKeyToString(parsed: ReturnType<typeof parseLocalizeKeyOrValue>): string {
	return typeof parsed === 'string' ? parsed : parsed.key;
}

function nlsMessageToString(parsed: ReturnType<typeof parseLocalizeKeyOrValue>): string {
	if (typeof parsed === 'string') {
		return parsed;
	}
	if (typeof parsed === 'object' && parsed !== null && 'key' in parsed) {
		return parsed.key;
	}
	return String(parsed);
}

/**
 * Same ordering as build/lib/nls.ts patch(): all localize() calls (sorted by first-arg span),
 * then all localize2() calls (sorted by first-arg span).
 */
function extractModuleNls(source: string): { keys: string[]; messages: string[] } {
	const keys: string[] = [];
	const messages: string[] = [];

	for (const lc of analyzeLocalizeCalls(source, 'localize')) {
		keys.push(nlsKeyToString(parseLocalizeKeyOrValue(lc.key)));
		messages.push(nlsMessageToString(parseLocalizeKeyOrValue(lc.value)));
	}
	for (const lc of analyzeLocalizeCalls(source, 'localize2')) {
		keys.push(nlsKeyToString(parseLocalizeKeyOrValue(lc.key)));
		messages.push(nlsMessageToString(parseLocalizeKeyOrValue(lc.value)));
	}

	return { keys, messages };
}

// ---------------------------------------------------------------------------
// Write output files (format matches build/lib/nls.ts global ordering)
// ---------------------------------------------------------------------------

async function writeNLSFilesFromOrderedModules(
	nlsKeysJson: [string, string[]][],
	allMessages: string[],
	outDir: string,
): Promise<void> {
	if (allMessages.length === 0) {
		console.warn('[vibe-nls] WARNING: 0 entries found — writing empty stubs');
		await Promise.all([
			fs.promises.writeFile(path.join(outDir, 'nls.keys.json'), '[]', 'utf-8'),
			fs.promises.writeFile(path.join(outDir, 'nls.messages.json'), '[]', 'utf-8'),
			fs.promises.writeFile(path.join(outDir, 'nls.metadata.json'), '{}', 'utf-8'),
			fs.promises.writeFile(path.join(outDir, 'nls.messages.js'), 'globalThis._VSCODE_NLS_MESSAGES=[];', 'utf-8'),
		]);
		return;
	}

	const moduleToKeys: Record<string, string[]> = {};
	const moduleToMessages: Record<string, string[]> = {};
	let sliceAt = 0;
	for (const [moduleId, keys] of nlsKeysJson) {
		const slice = allMessages.slice(sliceAt, sliceAt + keys.length);
		sliceAt += keys.length;
		moduleToKeys[moduleId] = keys;
		moduleToMessages[moduleId] = slice;
	}
	if (sliceAt !== allMessages.length) {
		throw new Error(`[vibe-nls] internal: message count mismatch (${sliceAt} vs ${allMessages.length})`);
	}

	const nlsMetadataJson = {
		keys: moduleToKeys,
		messages: moduleToMessages,
	};

	await fs.promises.mkdir(outDir, { recursive: true });
	await Promise.all([
		fs.promises.writeFile(path.join(outDir, 'nls.messages.json'), JSON.stringify(allMessages), 'utf-8'),
		fs.promises.writeFile(path.join(outDir, 'nls.keys.json'), JSON.stringify(nlsKeysJson), 'utf-8'),
		fs.promises.writeFile(path.join(outDir, 'nls.metadata.json'), JSON.stringify(nlsMetadataJson, null, '\t'), 'utf-8'),
		fs.promises.writeFile(
			path.join(outDir, 'nls.messages.js'),
			`/*---------------------------------------------------------\n * Copyright (C) Microsoft Corporation. All rights reserved.\n *--------------------------------------------------------*/\nglobalThis._VSCODE_NLS_MESSAGES=${JSON.stringify(allMessages)};`,
			'utf-8'
		),
	]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log('[vibe-nls] Extracting NLS metadata (gulp-compatible) ...');
	const t0 = Date.now();

	if (!fs.existsSync(OUT_DIR)) {
		console.error(`[vibe-nls] out/ not found at ${OUT_DIR}`);
		console.error('[vibe-nls] Run: npm run compile   first');
		process.exit(1);
	}

	const rawRel = await Array.fromAsync(
		fsGlob('**/*.ts', {
			cwd: SRC_DIR,
		})
	);

	const sortedAbsPaths = rawRel
		.map(r => r.replace(/\\/g, '/'))
		.filter(r => !shouldSkipTsSource(r))
		.map(rel => path.join(SRC_DIR, rel))
		.sort((a, b) => a.localeCompare(b));

	console.log(`[vibe-nls] Scanning ${sortedAbsPaths.length} TypeScript files (sorted by absolute path)...`);

	const nlsKeysJson: [string, string[]][] = [];
	const allMessages: string[] = [];
	let entryCount = 0;

	for (let i = 0; i < sortedAbsPaths.length; i++) {
		const absPath = sortedAbsPaths[i];
		const rel = path.relative(SRC_DIR, absPath).replace(/\\/g, '/');
		const moduleId = rel.replace(/\.ts$/, '');
		try {
			const source = await fs.promises.readFile(absPath, 'utf-8');
			const { keys, messages } = extractModuleNls(source);
			if (keys.length === 0) {
				continue;
			}
			if (keys.length !== messages.length) {
				throw new Error(`[vibe-nls] keys/messages length mismatch in ${rel}`);
			}
			nlsKeysJson.push([moduleId, keys]);
			for (const m of messages) {
				allMessages.push(m);
			}
			entryCount += keys.length;
		} catch {
			// skip unreadable
		}

		if ((i + 1) % 1000 === 0 || i + 1 === sortedAbsPaths.length) {
			console.log(`[vibe-nls]   ${i + 1}/${sortedAbsPaths.length} files (${entryCount} entries)...`);
		}
	}

	await writeNLSFilesFromOrderedModules(nlsKeysJson, allMessages, OUT_DIR);

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log(`[vibe-nls] Done: ${entryCount} NLS entries in ${elapsed}s`);
	console.log(`[vibe-nls]   → ${path.join(OUT_DIR, 'nls.keys.json')}`);
	console.log(`[vibe-nls]   → ${path.join(OUT_DIR, 'nls.messages.json')}`);
}

main().catch(err => {
	console.error('[vibe-nls] Extraction failed:', err);
	process.exit(1);
});
