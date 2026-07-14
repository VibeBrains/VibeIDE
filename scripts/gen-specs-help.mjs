/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `vibeSpecsHelp.generated.ts` from `docs/manuals/specsWorkflow.md`.
 *
 * The manual is the single source of truth for «как работать со спеками»: the same text serves
 * readers of the repo and the «?» modal in the «Спеки» panel. Embedding it at build time means a
 * doc edit lands in the next build automatically — no second copy to keep in sync and no way for
 * the modal to describe behaviour the docs no longer claim.
 *
 * Only the region between the markers is embedded, so the manual can carry a heading and editor
 * notes that have no business inside a modal.
 *
 * Run: `npm run gen:specs-help` (also part of `npm run gen:all`, which `precompile` runs before
 * every compile and the release scripts invoke before packaging).
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const SRC_FILE = path.join(repoRoot, 'docs', 'manuals', 'specsWorkflow.md');
const OUT_FILE = path.join(repoRoot, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'vibeSpecsHelp.generated.ts');

const START_MARKER = '<!-- specs-help:start -->';
const END_MARKER = '<!-- specs-help:end -->';

async function main() {
	let raw;
	try {
		raw = await fs.readFile(SRC_FILE, 'utf8');
	} catch (err) {
		console.error(`[gen-specs-help] cannot read ${path.relative(repoRoot, SRC_FILE)}: ${err.message}`);
		process.exit(1);
	}

	// Normalize CRLF → LF so the embedded bytes are platform-independent. The generator reads the
	// working-tree copy, which `text=auto` checks out as CRLF on Windows; without this, regenerating
	// on Windows vs macOS flips the embedded string's line endings and churns the file.
	const contents = raw.replace(/\r\n/g, '\n');

	const start = contents.indexOf(START_MARKER);
	const end = contents.indexOf(END_MARKER);
	if (start === -1 || end === -1 || end < start) {
		console.error(`[gen-specs-help] markers ${START_MARKER} … ${END_MARKER} not found (or reversed) in ${path.relative(repoRoot, SRC_FILE)}`);
		process.exit(1);
	}

	const body = contents.slice(start + START_MARKER.length, end).trim();
	if (!body) {
		console.error(`[gen-specs-help] the region between the markers is empty — refusing to ship an empty help modal`);
		process.exit(1);
	}

	const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */
// AUTO-GENERATED from docs/manuals/specsWorkflow.md — DO NOT EDIT BY HAND.
// Edit the manual instead; \`npm run gen:specs-help\` (part of \`gen:all\`, run by \`precompile\`)
// regenerates this file, so a doc change reaches the next build on its own.

/** Markdown body of the «Как работать со спеками» modal («?» in the «Спеки» panel title). */
export const VIBE_SPECS_HELP_MARKDOWN = ${JSON.stringify(body)};
`;

	await fs.writeFile(OUT_FILE, banner, 'utf8');
	console.log(`[gen-specs-help] wrote ${body.length} chars → ${path.relative(repoRoot, OUT_FILE)}`);
}

main();
