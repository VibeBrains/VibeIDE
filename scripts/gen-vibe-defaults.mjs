/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `vibeDefaultsManifest.generated.ts` from the repo's `.vibe-defaults/` folder.
 *
 * `.vibe-defaults/` holds the default agent scaffolding (rules, skills, prompts) that VibeIDE
 * seeds into a workspace `.vibe/` on first open and via the «Установить дефолтную обвязку»
 * command. The folder is the editable source of truth; this script embeds its contents into a
 * TS module so the packaged renderer can write the files at runtime without shipping/resolving
 * an external resource directory.
 *
 * Run: `npm run gen:vibe-defaults` (also invoked automatically by release-windows.ps1 before
 * each build, so every package reflects the current `.vibe-defaults/`).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SRC_DIR = path.join(repoRoot, '.vibe-defaults');
const OUT_FILE = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'vibeDefaultsManifest.generated.ts');

/** Recursively collect file paths under `dir`, returned as POSIX-relative to SRC_DIR. */
/**
 * Minimal JSONC → JSON for the set's hand-written metadata: `//` comments outside strings and
 * trailing commas. Deliberately local to this script — the generator must not import from `src/`,
 * and the set's own files are the only thing it parses.
 */
function stripJsonc(text) {
	let out = '';
	let inString = false;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			out += c;
			if (c === '\\' && i + 1 < text.length) { out += text[++i]; continue; }
			if (c === quote) { inString = false; quote = null; }
			continue;
		}
		if (c === '"') { inString = true; quote = c; out += c; continue; }
		if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') { i++; }
			out += '\n';
			continue;
		}
		if (c === ',') {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) { j++; }
			if (text[j] === '}' || text[j] === ']') { continue; }
		}
		out += c;
	}
	return out;
}

async function collectFiles(dir) {
	const out = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		// `.vibe-defaults` is a submodule (the seed set lives in the VibeBrains repo), so its root
		// holds a `.git` gitlink — a FILE, not a directory. Without this it would ship inside the
		// product as a seed and land in every new project's `.vibe/`.
		if (entry.name === '.git') { continue; }
		const abs = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...await collectFiles(abs));
		} else if (entry.isFile()) {
			out.push(abs);
		}
	}
	return out;
}

async function main() {
	let files;
	try {
		files = await collectFiles(SRC_DIR);
	} catch (err) {
		console.error(`[gen-vibe-defaults] cannot read ${SRC_DIR}: ${err.message}`);
		process.exit(1);
	}

	// Deterministic order so the generated file is stable across runs (clean diffs).
	files.sort();

	const entries = [];
	let deprecated = [];
	let versions = {};

	// Our own id, and ONLY our own. The list of who else exists is deliberately not here: a second
	// copy of that list is how two products drift apart silently — exactly how the `cost*` rename
	// went unnoticed. The dictionary is read from the set below.
	const PRODUCT_ID = 'vibeide';

	// Read before the loop: addressing decides whether a file is emitted at all, and the loop
	// cannot depend on the alphabetical position of `products.json`.
	let knownProducts = [];
	let fileAddressing = new Map();
	{
		const abs = path.join(SRC_DIR, 'products.json');
		let raw;
		try {
			raw = (await fs.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
		} catch {
			raw = undefined; // an older set without addressing: everything is for everyone
		}
		if (raw !== undefined) {
			try {
				const parsed = JSON.parse(stripJsonc(raw));
				knownProducts = Array.isArray(parsed.products) ? parsed.products : [];
				for (const entry of parsed.files ?? []) {
					if (entry && typeof entry.path === 'string' && Array.isArray(entry.products)) {
						fileAddressing.set(entry.path, entry.products);
					}
				}
			} catch (err) {
				console.error(`[gen-vibe-defaults] bad products.json: ${err.message}`);
				process.exit(1);
			}
		}
	}
	for (const abs of files) {
		const rel = path.relative(SRC_DIR, abs).split(path.sep).join('/');
		// Normalize CRLF → LF so the embedded bytes are platform-independent. The generator reads the
		// working-tree copy, which `text=auto` checks out as CRLF on Windows; without this, regenerating
		// on Windows vs macOS flips every embedded string's line endings and churns the whole manifest.
		const contents = (await fs.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
		// Set metadata, not a seed: deprecated.json lists files DROPPED from the set with the sha256
		// of every known historical version — the seeder deletes an untouched stale copy and never
		// a user-edited one. Seeding the manifest itself into projects would be noise.
		if (rel === 'versions.json') {
			// Реестр ревизий набора: sha256 текущей версии каждого файла и всех прошлых.
			// По нему сеялка отличает нетронутую копию старого релиза (обновляется молча)
			// от правки пользователя (не трогаем). Сам в проекты не сеется.
			try {
				versions = JSON.parse(contents).files ?? {};
			} catch (err) {
				console.error(`[gen-vibe-defaults] bad versions.json: ${err.message}`);
				process.exit(1);
			}
			continue;
		}
		if (rel === 'bump.mjs') {
			continue; // скрипт набора, не сид
		}
		if (rel === 'products.json') {
			continue; // словарь продуктов и адресация — метаданные набора, не сид
		}
		const addressedTo = fileAddressing.get(rel);
		if (addressedTo && !addressedTo.includes(PRODUCT_ID)) {
			// Not «disabled» — absent. A file for a product we are not has nothing to switch off.
			console.log(`[gen-vibe-defaults] ${rel} — адресован ${addressedTo.join(', ')}, не встраиваем`);
			continue;
		}
		if (rel === 'deprecated.json') {
			try {
				deprecated = JSON.parse(contents).deprecated ?? [];
			} catch (err) {
				console.error(`[gen-vibe-defaults] bad deprecated.json: ${err.message}`);
				process.exit(1);
			}
			continue;
		}
		entries.push(`\t{ path: ${JSON.stringify(rel)}, contents: ${JSON.stringify(contents)} },`);
	}
	const versionEntries = Object.entries(versions).map(([path, v]) =>
		`\t{ path: ${JSON.stringify(path)}, version: ${JSON.stringify(v.version ?? 1)}, sha256: ${JSON.stringify(v.sha256)}, history: ${JSON.stringify(v.history ?? [])} },`);
	const deprecatedEntries = deprecated.map(d =>
		`\t{ path: ${JSON.stringify(d.path)}, replacedBy: ${JSON.stringify(d.replacedBy ?? null)}, sha256: ${JSON.stringify(d.sha256 ?? [])} },`);

	const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */
// AUTO-GENERATED from .vibe-defaults/ — DO NOT EDIT BY HAND.
// Regenerate: \`npm run gen:vibe-defaults\` (or it runs automatically before a release build).

/** One embedded default file. \`path\` is POSIX-relative to the workspace \`.vibe/\` folder. */
export interface VibeDefaultFile {
	readonly path: string;
	readonly contents: string;
}

export const VIBE_DEFAULTS_MANIFEST: ReadonlyArray<VibeDefaultFile> = [
${entries.join('\n')}
];

/**
 * A seed the set has since dropped or renamed. \`sha256\` holds the hex digest of every known
 * historical version (LF-normalized UTF-8) — a workspace copy matching one of them was never
 * edited by the user and is safe to delete; anything else is the user's work and stays.
 */
export interface VibeDeprecatedSeed {
	readonly path: string;
	readonly replacedBy: string | null;
	readonly sha256: readonly string[];
}

export const VIBE_DEPRECATED_MANIFEST: ReadonlyArray<VibeDeprecatedSeed> = [
${deprecatedEntries.join('\n')}
];

/**
 * Ревизия файла набора. \`history\` — sha256 всех прошлых версий: копия, совпавшая с одной из
 * них, никем не правилась, и обновить её можно молча. Хэши считаются от LF-нормализованного UTF-8.
 */
export interface VibeSeedRevision {
	readonly path: string;
	readonly version: number;
	readonly sha256: string;
	readonly history: readonly string[];
}

export const VIBE_VERSIONS_MANIFEST: ReadonlyArray<VibeSeedRevision> = [
${versionEntries.join('\n')}
];

/** Наш собственный id в наборе. */
export const VIBE_PRODUCT_ID = ${JSON.stringify(PRODUCT_ID)};

/**
 * Словарь продуктов, объявленный САМИМ набором (\`products.json\`).
 *
 * Встроен, а не переписан константой: строгую проверку делает тест, а тест, сверяющийся с
 * собственным списком, проверяет себя. Пустой список означает набор без адресации — тест обязан
 * это заметить и сказать, а не отрапортовать успех.
 */
export const VIBE_KNOWN_PRODUCTS: readonly string[] = ${JSON.stringify(knownProducts)};

/** Адресация файлов набора: путь → продукты, которым он предназначен. */
export const VIBE_FILE_ADDRESSING: ReadonlyArray<{ readonly path: string; readonly products: readonly string[] }> = [
${[...fileAddressing.entries()].map(([p, list]) => `\t{ path: ${JSON.stringify(p)}, products: ${JSON.stringify(list)} },`).join('\n')}
];
`;

	await fs.writeFile(OUT_FILE, banner, 'utf8');
	console.log(`[gen-vibe-defaults] wrote ${entries.length} files → ${path.relative(repoRoot, OUT_FILE)}`);
}

main();
