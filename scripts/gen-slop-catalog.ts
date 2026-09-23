/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generates `slopCatalog.generated.ts`: the catalogue of AI-writing tells from the shared `.vibe` set
 * (`.vibe-defaults/slop/catalog.jsonc`), embedded in the build.
 *
 * WHY EMBEDDED AND NOT SEEDED: `products.json` of the set addresses the catalogue to no product on purpose —
 * a copy seeded into a project would freeze today's lists the way a seeded base-language file freezes today's
 * wording. Products read it from the build; a project only says how it differs, in `.vibe/slop.json`.
 *
 * WHY THE RAW JSONC: the English half of the catalogue comes from misbahsy/anti-ai-slop under MIT, and its
 * licence text lives in the file's header comment — it has to travel with the data.
 *
 * The catalogue's patterns are written for Java; the build refuses one that does not compile as a JavaScript
 * `RegExp` with the flags the detector uses, rather than ship a rule that silently finds nothing.
 *
 * Run: `npm run gen:slop-catalog` (part of `gen:all`, which `precompile` runs before every compile).
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, '.vibe-defaults', 'slop', 'catalog.jsonc');
const OUT_FILE = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide', 'common', 'slopCatalog.generated.ts');

/** Comments and trailing commas out, strings untouched: enough JSONC for a data file of the set. */
function stripJsonc(text: string): string {
	return text
		.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_match: string, quoted: string | undefined) => quoted ?? '')
		.replace(/,(\s*[}\]])/g, '$1');
}

interface CatalogShape {
	readonly version?: unknown;
	readonly scoring?: unknown;
	readonly rules?: ReadonlyArray<{ readonly id?: string; readonly caseSensitive?: boolean; readonly patterns?: readonly string[] }>;
}

function problemsOf(text: string): string[] {
	let catalog: CatalogShape;
	try {
		catalog = JSON.parse(stripJsonc(text));
	} catch (error) {
		return [`does not parse: ${error instanceof Error ? error.message : String(error)}`];
	}
	const problems: string[] = [];
	if (catalog?.version !== 1) {
		problems.push(`version ${String(catalog?.version)} — the detector reads version 1`);
	}
	if (!catalog?.scoring || typeof catalog.scoring !== 'object') {
		problems.push('no scoring');
	}
	if (!Array.isArray(catalog?.rules) || catalog.rules.length === 0) {
		problems.push('no rules');
		return problems;
	}
	for (const rule of catalog.rules) {
		for (const pattern of rule.patterns ?? []) {
			try {
				new RegExp(pattern, rule.caseSensitive ? 'gmu' : 'gimu');
			} catch (error) {
				problems.push(`${rule.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return problems;
}

let text: string;
try {
	text = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
} catch (error) {
	console.error(`[gen-slop-catalog] cannot read ${path.relative(ROOT, SOURCE)}: ${error instanceof Error ? error.message : String(error)} — is the .vibe-defaults submodule checked out?`);
	process.exit(1);
}
const problems = problemsOf(text);
if (problems.length > 0) {
	console.error(`[gen-slop-catalog] the catalogue cannot ship:\n  ${problems.join('\n  ')}`);
	process.exit(1);
}

const banner = `/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* eslint-disable */
// AUTO-GENERATED from .vibe-defaults/slop/catalog.jsonc — DO NOT EDIT BY HAND.
// Edit the catalogue in the VibeBrains set; \`npm run gen:slop-catalog\` (part of \`gen:all\`, run by
// \`precompile\`) regenerates this file. The text is embedded as is: its header carries the MIT licence
// of the English half (misbahsy/anti-ai-slop), which travels with the data.

/** The shared catalogue of AI-writing tells, JSONC, as the set ships it. */
export const SLOP_CATALOG_JSONC: string = ${JSON.stringify(text)};
`;

fs.writeFileSync(OUT_FILE, banner, 'utf8');
console.log(`[gen-slop-catalog] wrote ${Math.round(text.length / 1024)} KB → ${path.relative(ROOT, OUT_FILE)}`);
