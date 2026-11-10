/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Заранее кладёт в кэш node-gyp заголовки, под которые собираются нативные модули
// Без этого заголовки качаются посреди npm ci, и один обрыв сети роняет всю сборку
// (release CI 40679735118, macOS x64: tree-sitter в build/ — «gyp ERR! … TypeError: terminated»)
// Цели берутся из .npmrc корня (Electron) и build/.npmrc (Node), а не из констант в CI

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(import.meta.dirname, '..');
const NPMRC_FILES = ['.npmrc', 'build/.npmrc'];
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 15_000;

/**
 * Читает target и disturl из .npmrc
 * @param {string} file путь от корня репозитория
 * @returns {{ target: string, distUrl: string } | undefined}
 */
function readGypTarget(file) {
	const path = join(ROOT, file);
	if (!existsSync(path)) {
		return undefined;
	}
	const values = new Map();
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const match = /^\s*(?<key>[\w-]+)\s*=\s*"?(?<value>[^"]*)"?\s*$/.exec(line);
		if (match?.groups) {
			values.set(match.groups.key, match.groups.value);
		}
	}
	const target = values.get('target');
	const distUrl = values.get('disturl');
	return target && distUrl ? { target, distUrl } : undefined;
}

/**
 * Путь к node-gyp, который поставляется вместе с npm
 * @returns {string}
 */
function bundledNodeGyp() {
	const globalRoot = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
	const path = join(globalRoot, 'npm', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
	if (!existsSync(path)) {
		throw new Error(`node-gyp не найден рядом с npm: ${path}`);
	}
	return path;
}

const nodeGyp = bundledNodeGyp();
const targets = NPMRC_FILES.map(readGypTarget).filter(t => t !== undefined);
if (targets.length === 0) {
	throw new Error(`Ни в одном из ${NPMRC_FILES.join(', ')} нет пары target и disturl`);
}

for (const { target, distUrl } of targets) {
	for (let attempt = 1; ; attempt++) {
		try {
			console.log(`Заголовки ${target} с ${distUrl}, попытка ${attempt}`);
			execFileSync(process.execPath, [nodeGyp, 'install', `--target=${target}`, `--dist-url=${distUrl}`, '--ensure'], { stdio: 'inherit' });
			break;
		} catch (error) {
			if (attempt >= MAX_ATTEMPTS) {
				throw error;
			}
			await sleep(RETRY_DELAY_MS * attempt);
		}
	}
}
