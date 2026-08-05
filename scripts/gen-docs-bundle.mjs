/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `vibeDocsBundle.generated.ts` from the user-facing documentation.
 *
 * WHY: the agent could not use features this product already had — it did not know the format of
 * `.vibe/servers.json` (it lives in TypeScript types) and did not know an open preview is the
 * precondition for the design detector. It went looking on GitHub and found nothing. Shipping the
 * docs inside the build makes them reachable offline AND pins them to the version the user
 * actually installed, rather than whatever `main` looks like today.
 *
 * WHY A GENERATED .ts AND NOT `resources/`: a resource folder has to be wired into the packaging
 * lists, and this repo already lost a file that way — `vibeVoiceWorkerMain` was registered in the
 * dead list and silently never landed in the `.app` (bug in 1.9.1, `knowledge/build/…`). A
 * generated module is bundled by construction, is readable from the browser layer with no IPC,
 * and needs no dev-vs-packaged path resolution.
 *
 * WHAT SHIPS: `docs/functional.md` (what the product does) + everything in `docs/manuals/`
 * (how to do things). `docs/knowledge/` is deliberately EXCLUDED — it is our own engineering
 * kitchen (build gotchas, incident post-mortems) and would only add noise to a user-facing answer.
 *
 * Run: `npm run gen:docs-bundle` (part of `gen:all`, which `precompile` runs before every compile
 * and the release scripts invoke before packaging), so a doc edit reaches the next build by itself.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const DOCS_ROOT = path.join(repoRoot, 'docs');
const MANUALS_DIR = path.join(DOCS_ROOT, 'manuals');
const OUT_FILE = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'vibeDocsBundle.generated.ts');

/**
 * Single files taken from the docs root, in the order they should appear.
 * `README.md` is the docs index — without it a search can find a topic but not the map of what
 * exists at all, which is half the question when someone asks "где про это написано?".
 */
const ROOT_FILES = ['functional.md', 'README.md'];

/** Guard against the bundle quietly ballooning — user docs are not supposed to reach this size. */
const MAX_TOTAL_BYTES = 600 * 1024;

async function collect() {
	const entries = [];

	for (const name of ROOT_FILES) {
		const abs = path.join(DOCS_ROOT, name);
		entries.push({ file: name, contents: await fs.readFile(abs, 'utf8') });
	}

	const manuals = (await fs.readdir(MANUALS_DIR)).filter(f => f.endsWith('.md')).sort();
	for (const name of manuals) {
		const abs = path.join(MANUALS_DIR, name);
		entries.push({ file: `manuals/${name}`, contents: await fs.readFile(abs, 'utf8') });
	}

	return entries;
}

async function main() {
	let entries;
	try {
		entries = await collect();
	} catch (err) {
		console.error(`[gen-docs-bundle] cannot read docs: ${err.message}`);
		process.exit(1);
	}

	if (!entries.length) {
		console.error('[gen-docs-bundle] nothing collected — refusing to ship an empty documentation bundle');
		process.exit(1);
	}

	// Normalize CRLF → LF so the embedded bytes are platform-independent: the working tree checks
	// out as CRLF on Windows, and without this the generated file churns between machines.
	const normalised = entries.map(e => ({ file: e.file, contents: e.contents.replace(/\r\n/g, '\n') }));
	const total = normalised.reduce((n, e) => n + e.contents.length, 0);
	if (total > MAX_TOTAL_BYTES) {
		console.error(`[gen-docs-bundle] bundle is ${Math.round(total / 1024)} KB, over the ${Math.round(MAX_TOTAL_BYTES / 1024)} KB guard — split the docs or raise the limit deliberately`);
		process.exit(1);
	}

	const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */
// AUTO-GENERATED from docs/functional.md + docs/manuals/*.md — DO NOT EDIT BY HAND.
// Edit the documentation instead; \`npm run gen:docs-bundle\` (part of \`gen:all\`, run by
// \`precompile\`) regenerates this file, so a doc change reaches the next build on its own.
//
// \`docs/knowledge/\` is intentionally NOT bundled — internal engineering notes, not user docs.

/** One documentation file shipped inside the build. */
export interface VibeDocsBundleEntry {
	/** Path as published, e.g. \`manuals/serversSpec.md\`. */
	readonly file: string;
	readonly contents: string;
}

/** User-facing documentation, embedded at build time. */
export const VIBE_DOCS_BUNDLE: readonly VibeDocsBundleEntry[] = ${JSON.stringify(normalised, null, '\t')};
`;

	await fs.writeFile(OUT_FILE, banner, 'utf8');
	console.log(`[gen-docs-bundle] wrote ${normalised.length} file(s), ${Math.round(total / 1024)} KB → ${path.relative(repoRoot, OUT_FILE)}`);
}

main();
