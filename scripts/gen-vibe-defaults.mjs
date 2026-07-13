/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
async function collectFiles(dir) {
	const out = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
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
	for (const abs of files) {
		const rel = path.relative(SRC_DIR, abs).split(path.sep).join('/');
		// Normalize CRLF → LF so the embedded bytes are platform-independent. The generator reads the
		// working-tree copy, which `text=auto` checks out as CRLF on Windows; without this, regenerating
		// on Windows vs macOS flips every embedded string's line endings and churns the whole manifest.
		const contents = (await fs.readFile(abs, 'utf8')).replace(/\r\n/g, '\n');
		entries.push(`\t{ path: ${JSON.stringify(rel)}, contents: ${JSON.stringify(contents)} },`);
	}

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
`;

	await fs.writeFile(OUT_FILE, banner, 'utf8');
	console.log(`[gen-vibe-defaults] wrote ${entries.length} files → ${path.relative(repoRoot, OUT_FILE)}`);
}

main();
