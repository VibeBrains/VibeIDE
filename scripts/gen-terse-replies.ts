/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `terseReplies.generated.ts`: the «Краткие ответы» style instruction from the shared `.vibe` set
 * (`.vibe-defaults/terse/replies.md`), embedded in the build.
 *
 * WHY EMBEDDED AND NOT SEEDED: `products.json` of the set addresses the file to no product on purpose — a copy seeded
 * into a project would freeze today's wording, and VibeIDE and VibeIDEA must send the model one and the same text.
 *
 * WHY THE RAW FILE: its header comment carries the MIT licence of the caveman skill the text is based on, and the
 * licence has to travel with the text. The header never reaches the model: `brevity.ts` drops it when it reads sections.
 *
 * The build refuses a file without the sections the product relies on, rather than ship a mode that silently sends
 * nothing: every level, the off notice and the short form.
 *
 * Run: `npm run gen:terse-replies` (part of `gen:all`, which `precompile` runs before every compile).
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '.vibe-defaults', 'terse', 'replies.md');
const OUT_FILE = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'prompt', 'terseReplies.generated.ts');

/** The sections `brevity.ts` reads by name; their headings are the contract shared with VibeIDEA */
const REQUIRED_HEADINGS: readonly string[] = ['level: lite', 'level: full', 'level: ultra', 'off', 'short'];

function problemsOf(text: string): string[] {
	if (!text.startsWith('<!--') || !text.includes('-->')) {
		return ['no leading comment — the licence notice must travel with the text'];
	}
	const headings = new Set([...text.matchAll(/^## (?<heading>.+)$/gm)].map(match => match.groups!.heading.trim().toLowerCase()));
	return REQUIRED_HEADINGS.filter(heading => !headings.has(heading)).map(heading => `no section «## ${heading}»`);
}

let text: string;
try {
	text = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
	console.error(`[gen-terse-replies] cannot read ${path.relative(ROOT, SOURCE)}: ${error instanceof Error ? error.message : String(error)} — is the .vibe-defaults submodule checked out?`);
	process.exit(1);
}
const problems = problemsOf(text);
if (problems.length > 0) {
	console.error(`[gen-terse-replies] the style instruction cannot ship:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}

const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */
// AUTO-GENERATED from .vibe-defaults/terse/replies.md — DO NOT EDIT BY HAND.
// Edit the text in the VibeBrains set; \`npm run gen:terse-replies\` (part of \`gen:all\`, run by \`precompile\`)
// regenerates this file. The text is embedded as is: its header carries the MIT licence of the caveman skill.

/** The shared «Краткие ответы» style instruction, Markdown, as the set ships it. */
export const TERSE_REPLIES_MD: string = ${JSON.stringify(text)};
`;

fs.writeFileSync(OUT_FILE, banner, 'utf8');
console.log(`[gen-terse-replies] wrote ${Math.round(text.length / 1024)} KB → ${path.relative(ROOT, OUT_FILE)}`);
