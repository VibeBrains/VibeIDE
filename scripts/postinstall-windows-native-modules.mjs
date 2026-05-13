/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *
 *  Windows: native addons (@vscode/*, sqlite, keymap, etc.) and @vscode/ripgrep binaries are often
 *  missing after npm install --ignore-scripts, interrupted postinstall, or failed node-gyp.
 *  Root .npmrc targets Electron; rebuild must run from repo root. @vscode/ripgrep postinstall
 *  exits early if bin/ exists even when rg.exe is absent — use --force in that case.
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');

/** @type {readonly { id: string; artifact: string }[]} */
const NATIVE_ARTIFACTS = [
	{
		id: '@vscode/policy-watcher',
		artifact: path.join(nm, '@vscode', 'policy-watcher', 'build', 'Release', 'vscode-policy-watcher.node'),
	},
	{
		id: '@vscode/spdlog',
		artifact: path.join(nm, '@vscode', 'spdlog', 'build', 'Release', 'spdlog.node'),
	},
	{
		id: '@vscode/sqlite3',
		artifact: path.join(nm, '@vscode', 'sqlite3', 'build', 'Release', 'vscode-sqlite3.node'),
	},
	{
		id: '@vscode/windows-mutex',
		artifact: path.join(nm, '@vscode', 'windows-mutex', 'build', 'Release', 'CreateMutex.node'),
	},
	{
		id: '@vscode/deviceid',
		artifact: path.join(nm, '@vscode', 'deviceid', 'build', 'Release', 'windows.node'),
	},
	{
		id: 'native-is-elevated',
		artifact: path.join(nm, 'native-is-elevated', 'build', 'Release', 'iselevated.node'),
	},
	{
		id: '@vscode/windows-registry',
		artifact: path.join(nm, '@vscode', 'windows-registry', 'build', 'Release', 'winregistry.node'),
	},
	{
		// Optional dependency of @vscode/proxy-agent. Without crypt32.node Node-fetch
		// (undici) falls back to the embedded Mozilla CA bundle and cannot validate
		// any TLS chain rooted in a Windows-only or corporate CA — every cloud
		// LLM provider call then fails with APIConnectionError on locked-down networks.
		id: '@vscode/windows-ca-certs',
		artifact: path.join(nm, '@vscode', 'windows-ca-certs', 'build', 'Release', 'crypt32.node'),
	},
	{
		id: '@vscode/vsce-sign',
		artifact: path.join(nm, '@vscode', 'vsce-sign', 'bin', 'vsce-sign.exe'),
	},
	{
		id: 'native-keymap',
		artifact: path.join(nm, 'native-keymap', 'build', 'Release', 'keymapping.node'),
	},
];

function rgExePath() {
	return path.join(nm, '@vscode', 'ripgrep', 'bin', 'rg.exe');
}

function needsRebuild() {
	const missingArtifacts = NATIVE_ARTIFACTS.filter((e) => !existsSync(e.artifact)).map((e) => e.id);
	return missingArtifacts;
}

function needsRipgrep() {
	if (process.platform !== 'win32') {
		return false;
	}
	return !existsSync(rgExePath());
}

function main() {
	if (process.platform !== 'win32') {
		return;
	}

	const missingPkgs = needsRebuild();
	const ripgrep = needsRipgrep();

	if (missingPkgs.length === 0 && !ripgrep) {
		return;
	}

	const npmCli = 'npm.cmd';

	if (missingPkgs.length > 0) {
		console.log(
			`[postinstall] Windows native artifacts missing (${missingPkgs.join(', ')}); running npm rebuild...`
		);
		const rebuild = spawnSync(npmCli, ['rebuild', ...missingPkgs], {
			cwd: root,
			stdio: 'inherit',
			shell: true,
			env: process.env,
		});
		if (rebuild.status !== 0) {
			console.error(
				'[postinstall] npm rebuild failed. Ensure VS Build Tools (C++, Spectre libs if required) are installed.'
			);
			process.exit(rebuild.status ?? 1);
		}
	}

	if (needsRipgrep()) {
		console.log('[postinstall] @vscode/ripgrep rg.exe missing; running postinstall with --force...');
		const ripgrepInstall = path.join(nm, '@vscode', 'ripgrep', 'lib', 'postinstall.js');
		if (!existsSync(ripgrepInstall)) {
			console.error('[postinstall] Cannot find @vscode/ripgrep postinstall script.');
			process.exit(1);
		}
		const rg = spawnSync(process.execPath, [ripgrepInstall, '--force'], {
			cwd: root,
			stdio: 'inherit',
			env: process.env,
		});
		if (rg.status !== 0) {
			process.exit(rg.status ?? 1);
		}
	}
}

main();
