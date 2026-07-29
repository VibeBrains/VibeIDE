/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Type-checks the VibeIDE React sources.
 *
 * Why a wrapper instead of a bare `tsgo --project`: `react/**` is excluded from
 * `src/tsconfig.json`, so these ~56 TSX files are the only part of the fork nothing type-checks —
 * `npm run buildreact` merely bundles them. Running tsgo over them necessarily pulls in the
 * workbench modules they import, and errors reported *there* belong to other gates
 * (`compile-check-ts-native`, `valid-layers-check`), not to this one. So the exit code is driven
 * by errors under `react/src/` only; everything else is printed as an informational tail.
 *
 * Usage: node scripts/vibe-react-typecheck.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const reactDir = join(repoRoot, 'src/vs/workbench/contrib/vibeide/browser/react');

/** Errors whose path starts with this prefix are ours; tsgo reports paths relative to `reactDir`. */
const OWN_PREFIX = 'src/';
const ERROR_LINE = /^(?<file>\S+?)\((?<line>\d+),\d+\): error (?<code>TS\d+):/;

const result = spawnSync('npx', ['tsgo', '--project', './tsconfig.json'], {
	cwd: reactDir,
	encoding: 'utf8',
	shell: process.platform === 'win32',
});

if (result.error) {
	console.error(`[react-typecheck] failed to run tsgo: ${result.error.message}`);
	process.exit(1);
}

const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n');
const own = [];
const imported = [];
for (const line of lines) {
	const match = ERROR_LINE.exec(line);
	if (!match) {
		continue;
	}
	(match.groups.file.startsWith(OWN_PREFIX) ? own : imported).push(line);
}

if (own.length) {
	console.error(`[react-typecheck] ${own.length} error(s) in react/src:\n`);
	console.error(own.join('\n'));
} else {
	console.log('[react-typecheck] react/src clean.');
}

if (imported.length) {
	const files = new Set(imported.map(line => ERROR_LINE.exec(line).groups.file));
	console.log(
		`\n[react-typecheck] ${imported.length} error(s) in imported workbench modules ` +
		`(${files.size} file(s)) — not this gate's scope, see compile-check-ts-native / valid-layers-check.`
	);
}

process.exit(own.length ? 1 : 0);
