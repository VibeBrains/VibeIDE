#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sync the dispatcher and its companion scripts from the VibeIDE repo
 * into `cli-standalone/scripts/`. Used by `npm run sync` (dev) and by
 * `prepublishOnly` (release).
 *
 * Resolution:
 *   1. $VIBEIDE_REPO env — absolute path to a VibeIDE checkout.
 *   2. Parent of this package (when checked out inside the repo).
 *   3. Fail with exit 1.
 *
 * Flags:
 *   --check  exit 0 if the bundle exists & has vibe.js; non-zero otherwise.
 *            Does not copy. Use in CI / prepublishOnly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HERE = path.resolve(__dirname, '..');
const TARGET = path.join(HERE, 'scripts');
const CHECK = process.argv.includes('--check');

function findRepoRoot() {
	if (process.env.VIBEIDE_REPO) {
		const abs = path.resolve(process.env.VIBEIDE_REPO);
		if (fs.existsSync(path.join(abs, 'scripts', 'vibe.js'))) { return abs; }
	}
	const parent = path.resolve(HERE, '..');
	if (fs.existsSync(path.join(parent, 'scripts', 'vibe.js'))) { return parent; }
	return null;
}

if (CHECK) {
	if (!fs.existsSync(path.join(TARGET, 'vibe.js'))) {
		process.stderr.write('@vibeide/cli-standalone: bundle missing — run `npm run sync` before publishing.\n');
		process.exit(1);
	}
	process.exit(0);
}

const repo = findRepoRoot();
if (!repo) {
	process.stderr.write('@vibeide/cli-standalone: VibeIDE repo not found. Set $VIBEIDE_REPO or run from a checkout.\n');
	process.exit(1);
}

fs.mkdirSync(TARGET, { recursive: true });

// Copy vibe.js + every vibe-*.js sibling (these are the dispatch targets).
const repoScripts = path.join(repo, 'scripts');
const entries = fs.readdirSync(repoScripts);
let copied = 0;
for (const name of entries) {
	if (name !== 'vibe.js' && !/^vibe-.*\.(js|mjs|cjs)$/.test(name)) { continue; }
	const src = path.join(repoScripts, name);
	const dst = path.join(TARGET, name);
	fs.copyFileSync(src, dst);
	copied++;
}

// Also copy scripts/lib/ if present — several vibe-* helpers depend on it.
const repoLib = path.join(repoScripts, 'lib');
if (fs.existsSync(repoLib) && fs.statSync(repoLib).isDirectory()) {
	const libDst = path.join(TARGET, 'lib');
	fs.mkdirSync(libDst, { recursive: true });
	for (const name of fs.readdirSync(repoLib)) {
		fs.copyFileSync(path.join(repoLib, name), path.join(libDst, name));
		copied++;
	}
}

process.stdout.write(`@vibeide/cli-standalone: synced ${copied} file(s) from ${path.relative(process.cwd(), repo) || repo}.\n`);
