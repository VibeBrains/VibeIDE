/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'path';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { electronExecutableRelPath, isExpectedElectronInstalled } from './electronInstall.ts';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const rootDir = path.resolve(import.meta.dirname, '..', '..');

function runProcess(command: string, args: ReadonlyArray<string> = []) {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
		child.on('exit', err => !err ? resolve() : process.exit(err ?? 1));
		child.on('error', reject);
	});
}

function runProcessReturnCode(command: string, args: ReadonlyArray<string> = []): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
		child.on('exit', code => resolve(code));
		child.on('error', reject);
	});
}

async function exists(subdir: string) {
	try {
		await fs.stat(path.join(rootDir, subdir));
		return true;
	} catch {
		return false;
	}
}

async function ensureNodeModules() {
	if (!(await exists('node_modules'))) {
		await runProcess(npm, ['ci']);
	}
}

/**
 * Makes sure `.build/electron` holds the Electron from `.npmrc`
 * `npm run electron` (`electron.ts`) keeps an install of that version and downloads into a staging folder otherwise,
 * so a run without a network leaves the existing install in place instead of an empty folder
 * It is also skipped here when the install matches, which saves a node start for every launch
 * (and, on Windows, the file locks of an Electron that has just exited, that made the old delete-and-extract flaky)
 */
async function getElectron() {
	if (await hasExpectedElectron()) {
		return;
	}

	const max = Math.max(1, Number.parseInt(process.env['VSCODE_ELECTRON_DOWNLOAD_RETRIES'] ?? '5', 10) || 5);
	for (let attempt = 1; attempt <= max; attempt++) {
		const code = await runProcessReturnCode(npm, ['run', 'electron']);
		if (code === 0) {
			return;
		}
		if (attempt < max) {
			const delayMs = Math.min(30_000, 2000 * 2 ** (attempt - 1));
			console.log(`[preLaunch] npm run electron failed (exit ${code}), attempt ${attempt}/${max}; next retry in ${delayMs / 1000}s (unstable link to GitHub release assets).`);
			await new Promise(r => setTimeout(r, delayMs));
		} else {
			console.error('[preLaunch] npm run electron failed after retries. Try: set VIBE_ELECTRON_MIRROR=https://cdn.npmmirror.com/binaries/electron/ (see docs/knowledge/build/portableAndElectron.md).');
			process.exit(code ?? 1);
		}
	}
}

async function hasExpectedElectron(): Promise<boolean> {
	try {
		const { getElectronVersion } = await import('./util.ts');
		const { electronVersion } = getElectronVersion();
		const names = JSON.parse(await fs.readFile(path.join(rootDir, 'product.json'), 'utf8'));
		return await isExpectedElectronInstalled(path.join(rootDir, '.build', 'electron'), electronVersion, electronExecutableRelPath(process.platform, names));
	} catch {
		return false;
	}
}

async function ensureCompiled() {
	if (!(await exists('out'))) {
		await runProcess(npm, ['run', 'compile']);
	}
}

async function main() {
	await ensureNodeModules();
	await getElectron();
	await ensureCompiled();

	// Can't require this until after dependencies are installed
	const { getBuiltInExtensions } = await import('./builtInExtensions.ts');
	await getBuiltInExtensions();
}

if (import.meta.main) {
	main().catch(err => {
		console.error(err);
		process.exit(1);
	});
}
