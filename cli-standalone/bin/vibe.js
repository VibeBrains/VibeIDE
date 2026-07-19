#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Standalone vibe CLI — published as `@vibeide/cli-standalone`.
 *
 * Resolution order for the dispatcher target:
 *   1. $VIBEIDE_SCRIPTS — explicit override (absolute path to scripts/ dir).
 *   2. <package>/scripts/vibe.js   — bundled copy (populated by `npm run sync`).
 *   3. <cwd>/scripts/vibe.js       — running from a checkout.
 *   4. Walk parents from $cwd looking for a `scripts/vibe.js`.
 *
 * Exit codes:
 *   64 — bundled scripts/ missing (run `npm run sync` from a checkout).
 *   70 — dispatcher itself errored on spawn.
 *   any other — forwarded from the underlying scripts/vibe.js dispatch.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);

function resolveDispatcher() {
	const env = process.env.VIBEIDE_SCRIPTS;
	if (env) {
		const candidate = path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
		const direct = path.join(candidate, 'vibe.js');
		if (fs.existsSync(direct)) { return direct; }
	}

	const bundled = path.join(HERE, 'scripts', 'vibe.js');
	if (fs.existsSync(bundled)) { return bundled; }

	const cwdLocal = path.join(process.cwd(), 'scripts', 'vibe.js');
	if (fs.existsSync(cwdLocal)) { return cwdLocal; }

	let dir = process.cwd();
	for (let i = 0; i < 12; i++) {
		const candidate = path.join(dir, 'scripts', 'vibe.js');
		if (fs.existsSync(candidate)) { return candidate; }
		const parent = path.dirname(dir);
		if (parent === dir) { break; }
		dir = parent;
	}
	return null;
}

const dispatcher = resolveDispatcher();
if (!dispatcher) {
	process.stderr.write(
		'@vibeide/cli-standalone: scripts/vibe.js not found. Run `npm run sync` ' +
		'from a VibeIDE checkout to populate the bundle, or set $VIBEIDE_SCRIPTS ' +
		'to the absolute path of a scripts/ directory.\n',
	);
	process.exit(64);
}

const result = spawnSync(process.execPath, [dispatcher, ...argv], { stdio: 'inherit' });
if (result.error) {
	process.stderr.write(`@vibeide/cli-standalone: spawn error — ${result.error.message}\n`);
	process.exit(70);
}
process.exit(result.status ?? 0);
