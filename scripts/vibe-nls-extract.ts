#!/usr/bin/env -S npx tsx
/*---------------------------------------------------------------------------------------------
 *  VibeIDE NLS Extraction Script
 *
 *  Scans src/ TypeScript files, extracts all localize() / localize2() calls and writes:
 *    out/nls.keys.json
 *    out/nls.messages.json
 *    out/nls.metadata.json
 *
 *  These files are required by out/vs/base/node/nls.js to generate the per-locale
 *  translation cache in dev mode (scripts/vibe-dev.bat).
 *
 *  Usage:
 *    npx tsx scripts/vibe-nls-extract.ts [--out <dir>]
 *
 *  NOTE: Uses pure regex extraction (no TypeScript AST dependency) for reliability
 *  in both ESM and CJS execution contexts.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import glob from 'glob';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const globAsync = promisify(glob);

// ---------------------------------------------------------------------------
// Paths — works in both ESM and tsx CJS mode
// ---------------------------------------------------------------------------

const _scriptDir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(_scriptDir); // scripts/ → repo root
const SRC_DIR = path.join(REPO_ROOT, 'src');

function getArgValue(name: string): string | undefined {
	const idx = process.argv.indexOf(name);
	return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const OUT_DIR = path.join(REPO_ROOT, getArgValue('--out') ?? 'out');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NLSEntry {
	moduleId: string;
	key: string;
	message: string;
	placeholder: string;
}

// ---------------------------------------------------------------------------
// Extraction — pure regex, no TypeScript AST required
//
// VS Code NLS call forms:
//   localize('key', 'message', ...args)
//   localize("key", "message", ...args)
//   localize({ key: 'key', comment: [...] }, 'message', ...args)
//   localize2(...)  — same shapes
//   nls.localize(...)  — word-boundary handles this too
// ---------------------------------------------------------------------------

/** Skip whitespace chars starting at pos, return new position. */
function skipWS(src: string, pos: number): number {
	while (pos < src.length && (src[pos] === ' ' || src[pos] === '\t' || src[pos] === '\n' || src[pos] === '\r')) {
		pos++;
	}
	return pos;
}

/**
 * Parse a quoted string literal starting at `pos`.
 * Returns [value, endPos] or [null, pos] on failure.
 * Handles common escape sequences (\n, \t, \\, \', \").
 */
function parseString(src: string, pos: number): [string | null, number] {
	if (pos >= src.length) return [null, pos];
	const q = src[pos];
	if (q !== "'" && q !== '"') return [null, pos];

	let out = '';
	let i = pos + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === '\\') {
			i++;
			if (i >= src.length) break;
			const e = src[i];
			if (e === 'n') out += '\n';
			else if (e === 't') out += '\t';
			else if (e === 'r') out += '\r';
			else out += e; // handles \\, \', \", and anything else
			i++;
		} else if (c === q) {
			return [out, i + 1];
		} else {
			out += c;
			i++;
		}
	}
	return [null, pos]; // unterminated
}

/**
 * Parse an object literal `{ key: 'str', ... }` starting at `pos`, return [keyValue, endPos].
 * Extracts only the `key` property (string literal only).
 * Handles nested braces and quoted strings inside the object.
 */
function parseObjectKey(src: string, pos: number): [string | null, number] {
	if (pos >= src.length || src[pos] !== '{') return [null, pos];

	let depth = 0;
	let foundKey: string | null = null;
	let i = pos;

	while (i < src.length) {
		const c = src[i];

		if (c === '{') {
			depth++;
			i++;
		} else if (c === '}') {
			depth--;
			if (depth === 0) {
				return [foundKey, i + 1];
			}
			i++;
		} else if (c === "'" || c === '"') {
			// Skip string contents (don't match key: inside strings)
			const [, end] = parseString(src, i);
			i = end > i ? end : i + 1;
		} else if (c === '/' && src[i + 1] === '/') {
			// Skip line comment
			while (i < src.length && src[i] !== '\n') i++;
		} else if (c === '/' && src[i + 1] === '*') {
			// Skip block comment
			i += 2;
			while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
			i += 2;
		} else if (foundKey === null && depth === 1) {
			// Look for `key:` property at the current object level
			const rest = src.slice(i);
			const keyMatch = /^key\s*:/.exec(rest);
			if (keyMatch) {
				i += keyMatch[0].length;
				i = skipWS(src, i);
				const [val, end] = parseString(src, i);
				if (val !== null) {
					foundKey = val;
					i = end;
					continue;
				}
			} else {
				i++;
			}
		} else {
			i++;
		}
	}

	return [foundKey, i];
}

/**
 * Extract all localize() / localize2() calls from a TypeScript source file.
 * Returns NLSEntry[] with moduleId, key, message, placeholder.
 */
function extractLocalizeEntries(source: string, moduleId: string): NLSEntry[] {
	const entries: NLSEntry[] = [];
	const seen = new Set<string>();

	// Fast pre-check: skip files without any localize call
	if (!source.includes('localize(') && !source.includes('localize2(')) {
		return entries;
	}

	// Find every occurrence of `localize(` or `localize2(` (word-boundary enforced below)
	const RE = /\blocalize(2?)\s*\(/g;
	let m: RegExpExecArray | null;

	while ((m = RE.exec(source)) !== null) {
		const isLocalize2 = m[1] === '2';
		let pos = RE.lastIndex; // points right after '('

		pos = skipWS(source, pos);

		// --- Parse first argument (key) ---
		let key: string | null = null;
		let afterKey: number = pos;

		const firstChar = source[pos];
		if (firstChar === "'" || firstChar === '"') {
			[key, afterKey] = parseString(source, pos);
		} else if (firstChar === '{') {
			[key, afterKey] = parseObjectKey(source, pos);
		}

		if (key === null) continue;

		// --- Expect comma ---
		const commaPos = skipWS(source, afterKey);
		if (commaPos >= source.length || source[commaPos] !== ',') continue;
		let msgPos = skipWS(source, commaPos + 1);

		// --- Parse second argument (message, string literal only) ---
		if (source[msgPos] !== "'" && source[msgPos] !== '"') continue;
		const [message] = parseString(source, msgPos);
		if (message === null) continue;

		// --- Record entry ---
		const prefix = isLocalize2 ? 'NLS2' : 'NLS';
		const placeholder = `%%${prefix}:${moduleId}#${key}%%`;

		if (!seen.has(placeholder)) {
			seen.add(placeholder);
			entries.push({ moduleId, key, message, placeholder });
		}
	}

	return entries;
}

// ---------------------------------------------------------------------------
// Write output files (format matches build/next/nls-plugin.ts finalizeNLS)
// ---------------------------------------------------------------------------

async function writeNLSFiles(entries: NLSEntry[], outDir: string): Promise<void> {
	if (entries.length === 0) {
		console.warn('[vibe-nls] WARNING: 0 entries found — writing empty stubs');
		await Promise.all([
			fs.promises.writeFile(path.join(outDir, 'nls.keys.json'), '[]', 'utf-8'),
			fs.promises.writeFile(path.join(outDir, 'nls.messages.json'), '[]', 'utf-8'),
			fs.promises.writeFile(path.join(outDir, 'nls.metadata.json'), '{}', 'utf-8'),
			fs.promises.writeFile(path.join(outDir, 'nls.messages.js'), 'globalThis._VSCODE_NLS_MESSAGES=[];', 'utf-8'),
		]);
		return;
	}

	// Sort by moduleId → key for stable indices across runs
	entries.sort((a, b) => {
		const mc = a.moduleId.localeCompare(b.moduleId);
		return mc !== 0 ? mc : a.key.localeCompare(b.key);
	});

	// Build output structures
	const allMessages: string[] = [];
	const moduleToKeys = new Map<string, string[]>();
	const moduleToMessages = new Map<string, string[]>();

	for (const e of entries) {
		allMessages.push(e.message);
		if (!moduleToKeys.has(e.moduleId)) {
			moduleToKeys.set(e.moduleId, []);
			moduleToMessages.set(e.moduleId, []);
		}
		moduleToKeys.get(e.moduleId)!.push(e.key);
		moduleToMessages.get(e.moduleId)!.push(e.message);
	}

	// nls.keys.json: [[moduleId, [key, ...]], ...]
	const nlsKeysJson: [string, string[]][] = [...moduleToKeys.entries()].map(([m, keys]) => [m, keys]);

	const nlsMetadataJson = {
		keys: Object.fromEntries(moduleToKeys),
		messages: Object.fromEntries(moduleToMessages),
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
	console.log('[vibe-nls] Extracting NLS metadata from src/ ...');
	const t0 = Date.now();

	if (!fs.existsSync(OUT_DIR)) {
		console.error(`[vibe-nls] out/ not found at ${OUT_DIR}`);
		console.error('[vibe-nls] Run: npm run transpile-client   first');
		process.exit(1);
	}

	const files = await globAsync('**/*.ts', {
		cwd: SRC_DIR,
		ignore: ['**/*.d.ts', '**/test/**'],
	});

	console.log(`[vibe-nls] Scanning ${files.length} TypeScript files...`);

	const allEntries: NLSEntry[] = [];
	let processed = 0;
	const BATCH = 200;

	for (let i = 0; i < files.length; i += BATCH) {
		const batch = files.slice(i, i + BATCH);
		const results = await Promise.all(batch.map(async file => {
			const srcPath = path.join(SRC_DIR, file);
			try {
				const source = await fs.promises.readFile(srcPath, 'utf-8');
				const moduleId = file.replace(/\\/g, '/').replace(/\.ts$/, '');
				return extractLocalizeEntries(source, moduleId);
			} catch {
				return [] as NLSEntry[];
			}
		}));

		for (const batch_entries of results) {
			if (batch_entries.length > 0) allEntries.push(...batch_entries);
		}

		processed += batch.length;
		if (processed % 1000 === 0 || processed >= files.length) {
			console.log(`[vibe-nls]   ${processed}/${files.length} files (${allEntries.length} entries)...`);
		}
	}

	await writeNLSFiles(allEntries, OUT_DIR);

	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	console.log(`[vibe-nls] Done: ${allEntries.length} NLS entries in ${elapsed}s`);
	console.log(`[vibe-nls]   → ${path.join(OUT_DIR, 'nls.keys.json')}`);
	console.log(`[vibe-nls]   → ${path.join(OUT_DIR, 'nls.messages.json')}`);
}

main().catch(err => {
	console.error('[vibe-nls] Extraction failed:', err);
	process.exit(1);
});
