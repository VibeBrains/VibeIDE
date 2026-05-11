#!/usr/bin/env node
// Copyright 2026 VibeIDE Team. MIT License.
// Coverage check: every registered `vibeide.*` configuration key must be reachable
// through at least one glob-style pattern declared in settingsLayout.ts, so the
// native Settings UI surfaces it in its TOC instead of dropping it into the
// `leftoverSettings` warning.
//
// What we do:
//   1. Scan `src/vs/workbench/contrib/vibeide/**/*GlobalSettingsConfiguration.ts`
//      (and a couple of cousins) for `'vibeide.<key>'` string literals registered
//      via `registry.registerConfiguration`.
//   2. Read patterns from `settingsLayout.ts` (any string starting with `vibeide.`).
//   3. Fail if any registered key is not matched by any pattern.
//
// Run via `node scripts/vibe-settings-toc-coverage.mjs`. Exit code is non-zero on
// missing coverage; CI consumes it directly.

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const LAYOUT_PATH = join(ROOT, 'src/vs/workbench/contrib/preferences/browser/settingsLayout.ts');
const VIBEIDE_DIR = join(ROOT, 'src/vs/workbench/contrib/vibeide');

/** Recursively walk a directory; yield absolute file paths matching the extension list. */
async function* walk(dir, exts) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			// Skip generated / vendored / non-source trees.
			if (entry.name === 'node_modules' || entry.name === 'test' || entry.name.startsWith('.')) continue;
			yield* walk(full, exts);
		} else if (exts.some(ext => entry.name.endsWith(ext))) {
			yield full;
		}
	}
}

/** Compile a layout pattern like `vibeide.agent.*` into a regex.
 * Mirrors VS Code's `createSettingMatchRegExp` in preferences/settingsTree.ts: `*` → `.*`
 * (matches any chars including dots), so `vibeide.commands.*` covers
 * `vibeide.commands.toolbar.position`.
 */
function patternToRegex(pat) {
	const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
	return new RegExp('^' + escaped + '$', 'i');
}

async function main() {
	// 1. Collect registered keys.
	//
	// Heuristic: only treat a `'vibeide.…'` literal as a real setting key when it is
	// used as an object property key (followed by `:` after optional whitespace) and
	// the surrounding object looks like a JSON schema entry (`type: 'string' | …`,
	// `default`, `description`, …). Drops localize bundle keys like
	// `localize('vibeide.commands.toolbar.position.hidden', '…')` and decorator-style
	// references `createDecorator<…>('vibeide.foo')`.
	const propertyKeyRe = /['"`](vibeide\.[a-zA-Z0-9_.]+)['"`]\s*:\s*\{([\s\S]{0,200})/g;
	const schemaLikeRe = /\b(type|default|enum|description|markdownDescription|properties|scope|order)\s*:/;
	const registered = new Set();
	// Settings can be registered from a Configuration file or from a Service /
	// Contribution file (Service files often own a feature flag + its config). We
	// rely on the `propertyKeyRe + schemaLikeRe` pair to filter false positives
	// instead of restricting by filename.
	for await (const file of walk(VIBEIDE_DIR, ['.ts'])) {
		const src = await readFile(file, 'utf8');
		// Quick pre-filter — only look at files that actually reference the
		// configuration registry. Avoids scanning every .ts in the contrib.
		if (!src.includes('registerConfiguration') && !src.includes('properties:')) continue;
		let m;
		while ((m = propertyKeyRe.exec(src)) !== null) {
			const key = m[1];
			const peek = m[2];
			if (key.endsWith('.*')) continue;
			if (!schemaLikeRe.test(peek)) continue;
			registered.add(key);
		}
	}

	if (registered.size === 0) {
		console.error('vibe-settings-toc-coverage: no `vibeide.*` keys discovered — scanner is broken or refactored away.');
		process.exit(2);
	}

	// 2. Collect patterns from settingsLayout.ts.
	const layoutSrc = await readFile(LAYOUT_PATH, 'utf8');
	const patternRe = /['"`](vibeide(?:\.[a-zA-Z0-9_*]+)+|vibeide\.\*)['"`]/g;
	const patterns = [];
	let pm;
	while ((pm = patternRe.exec(layoutSrc)) !== null) {
		patterns.push(pm[1]);
	}
	if (patterns.length === 0) {
		console.error(`vibe-settings-toc-coverage: ${relative(ROOT, LAYOUT_PATH)} has no \`vibeide.*\` patterns.`);
		process.exit(2);
	}
	const regexes = patterns.map(patternToRegex);

	// 3. Cross-check.
	const uncovered = [];
	for (const key of registered) {
		if (!regexes.some(r => r.test(key))) {
			uncovered.push(key);
		}
	}

	if (uncovered.length) {
		uncovered.sort();
		console.error('vibe-settings-toc-coverage: the following `vibeide.*` keys are NOT covered by any pattern in settingsLayout.ts:');
		for (const k of uncovered) console.error('  - ' + k);
		console.error('\nFix: add a matching pattern under the `vibeide` TOC entry in `' + relative(ROOT, LAYOUT_PATH) + '` (e.g. `vibeide.newgroup.*`).');
		process.exit(1);
	}

	console.log(`vibe-settings-toc-coverage: OK — ${registered.size} key(s) covered by ${patterns.length} pattern(s).`);
}

main().catch(err => {
	console.error('vibe-settings-toc-coverage: unexpected error', err);
	process.exit(2);
});
