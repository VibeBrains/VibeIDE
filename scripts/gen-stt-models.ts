/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `sttModels.generated.ts`: the catalogue of speech-recognition models from the shared `.vibe` set
 * (`.vibe-defaults/voice/sttModels.jsonc`), embedded in the build.
 *
 * WHY EMBEDDED AND NOT SEEDED: `products.json` of the set addresses the file to no product — it is read from the
 * build, and a project gets no copy. Addresses, sizes and checksums live in the set rather than in constants of
 * each product: a copy of the list drifts silently, and an archive whose checksum differs is not downloaded at all.
 *
 * WHY THE RAW JSONC: its header comment explains the shape and records where the archives come from; it travels
 * with the data. The text is read at run time by `common/voice/sttModelsCatalog.ts`.
 *
 * The build refuses a catalogue the product could not use: the same code that reads it at run time judges it here
 * (unique archives, checksums, sizes, and every model file named by a profile among the files of its archive).
 *
 * Run: `npm run gen:stt-models` (part of `gen:all`, which `precompile` runs before every compile).
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '.vibe-defaults', 'voice', 'sttModels.jsonc');
const OUT_FILE = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'voice', 'sttModels.generated.ts');
// Imports nothing and uses only syntax Node can strip: the build reads the catalogue with the code the IDE runs
const { parseSttModelsCatalog } = require('../src/vs/workbench/contrib/vibeide/common/voice/sttModelsCatalog.ts') as typeof import('../src/vs/workbench/contrib/vibeide/common/voice/sttModelsCatalog.js');

let text: string;
try {
	text = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
	console.error(`[gen-stt-models] cannot read ${path.relative(ROOT, SOURCE)}: ${error instanceof Error ? error.message : String(error)} — is the .vibe-defaults submodule checked out?`);
	process.exit(1);
}
const { problems } = parseSttModelsCatalog(text);
if (problems.length > 0) {
	console.error(`[gen-stt-models] the catalogue cannot ship:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}

const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */
// AUTO-GENERATED from .vibe-defaults/voice/sttModels.jsonc — DO NOT EDIT BY HAND.
// Edit the catalogue in the VibeBrains set; \`npm run gen:stt-models\` (part of \`gen:all\`, run by
// \`precompile\`) regenerates this file. The text is embedded as is: its header comment says where
// the archives come from and what they are for.

/** The shared catalogue of speech-recognition models, JSONC, as the set ships it. */
export const STT_MODELS_JSONC: string = ${JSON.stringify(text)};
`;

fs.writeFileSync(OUT_FILE, banner, 'utf8');
console.log(`[gen-stt-models] wrote ${Math.round(text.length / 1024)} KB → ${path.relative(ROOT, OUT_FILE)}`);
