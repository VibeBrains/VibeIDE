/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Guard: every path that builds a macOS .dmg goes through scripts/build-dmg-macos.sh.
// The upstream build/darwin/create-dmg.ts draws the VS Code background and names the volume «VS Code»,
// so it must never be called from our release paths.
// Run: `node scripts/dmg-single-path.test.mts`. No deps.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** Пути, которые собирают .dmg для релиза */
const RELEASE_PATHS = ['.github/workflows/release.yml', 'scripts/release-macos.sh'];

let passed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		console.error(`FAIL - ${name}\n  ${e instanceof Error ? e.message : String(e)}`);
		process.exitCode = 1;
	}
}

for (const rel of RELEASE_PATHS) {
	const text = read(rel);
	// Строки-комментарии могут называть апстримовый скрипт, чтобы объяснить запрет; вызов — нет
	const code = text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
	test(`${rel}: собирает образ нашим build-dmg-macos.sh`, () => {
		assert.match(code, /build-dmg-macos\.sh/);
	});
	test(`${rel}: не вызывает апстримовый create-dmg.ts`, () => {
		assert.doesNotMatch(code, /create-dmg\.ts/);
	});
}

test('release.yml: имя образа несёт версию, как у ZIP той же сборки', () => {
	// В имени файла версия без ведущей «v», как у локальных скриптов (тег остаётся vX.Y.Z)
	const workflow = read('.github/workflows/release.yml');
	assert.match(workflow, /VibeIDE-\$\{VIBE_VERSION#v\}-darwin-\$\{\{ matrix\.arch \}\}\.dmg/);
	assert.match(workflow, /VibeIDE-\$\{VIBE_VERSION#v\}-darwin-\$\{\{ matrix\.arch \}\}\.zip/);
});

test('build-dmg-macos.sh: том называется VibeIDE', () => {
	assert.match(read('scripts/build-dmg-macos.sh'), /^VOLUME_NAME='VibeIDE'$/m);
});

console.log(`${passed} passed`);
