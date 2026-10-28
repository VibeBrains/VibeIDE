#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Zero-dependency guard for two extension-scan defects (VibeIDE 1.28.1):
//
// 1. Built-in extensions must not declare `contributes.configuration` keys that the workbench
//    already registers in `src/vs/workbench/contrib/vibeide/**`. A second declaration makes
//    `vibeide-neon` log «Невозможно зарегистрировать "<key>". Это свойство уже зарегистрировано.»
//    on every start.
//
// 2. The extension scanner must resolve the NLS language of every scan, and must not invalidate a
//    manifest cache written by a *different* scan input. The builtin manifest cache
//    (`extensions.builtin.cache`) is a single file shared by the renderer and main-process scanner
//    instances; when one scan ran with `language: undefined` (English manifests) and the other
//    with `platform.language` (`package.nls.ru.json` manifests), every start deleted the cache
//    written by the other scan and the workbench showed «Расширения были изменены на диске».
//
// Run: `node scripts/check-extension-scan-invariants.mts`. Exits non-zero and prints the findings.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir, filter, result = []) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			walk(path, filter, result);
		} else if (filter(path)) {
			result.push(path);
		}
	}
	return result;
}

/** Keys contributed by `contributes.configuration` of every built-in extension. */
export function collectExtensionContributedSettings(root = ROOT) {
	const extensionsDir = join(root, 'extensions');
	const settings = new Map();
	if (!existsSync(extensionsDir)) {
		return settings;
	}
	for (const entry of readdirSync(extensionsDir)) {
		const manifestPath = join(extensionsDir, entry, 'package.json');
		if (!existsSync(manifestPath)) {
			continue;
		}
		let manifest;
		try {
			manifest = readJson(manifestPath);
		} catch {
			continue;
		}
		const configuration = manifest?.contributes?.configuration;
		const configurations = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
		for (const config of configurations) {
			for (const key of Object.keys(config?.properties ?? {})) {
				settings.set(key, `extensions/${entry}/package.json`);
			}
		}
	}
	return settings;
}

/** Property keys registered from workbench code via `registerConfiguration({ ... 'key': {`. */
export function collectCoreRegisteredSettings(root = ROOT) {
	const vibeideDir = join(root, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
	const settings = new Map();
	if (!existsSync(vibeideDir)) {
		return settings;
	}
	const keyPattern = /^\s*'(vibeide\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'\s*:\s*\{/gm;
	for (const file of walk(vibeideDir, path => path.endsWith('.ts'))) {
		const content = readFileSync(file, 'utf8');
		if (!content.includes('registerConfiguration(')) {
			continue;
		}
		for (const match of content.matchAll(keyPattern)) {
			settings.set(match[1], file.slice(root.length + 1));
		}
	}
	return settings;
}

/** Settings declared twice: once in an extension manifest, once in the workbench. */
export function findDuplicateSettings(root = ROOT) {
	const contributed = collectExtensionContributedSettings(root);
	const registered = collectCoreRegisteredSettings(root);
	const duplicates = [];
	for (const [key, extensionFile] of contributed) {
		const coreFile = registered.get(key);
		if (coreFile) {
			duplicates.push(`${key} — ${extensionFile} (расширение) и ${coreFile} (ядро workbench)`);
		}
	}
	return duplicates.sort();
}

function extractFunctionBody(source, signature) {
	const start = source.indexOf(signature);
	if (start === -1) {
		return undefined;
	}
	const end = source.indexOf('\n\t}', start);
	if (end === -1) {
		return undefined;
	}
	return source.slice(start, end);
}

/** The scanner must (a) resolve the language of every input and (b) validate only its own cache. */
export function findScannerLanguageProblems(root = ROOT) {
	const scannerPath = join(root, 'src', 'vs', 'platform', 'extensionManagement', 'common', 'extensionsScannerService.ts');
	if (!existsSync(scannerPath)) {
		return [`не найден ${scannerPath}`];
	}
	const source = readFileSync(scannerPath, 'utf8');
	const problems = [];

	const createInput = extractFunctionBody(source, 'private async createExtensionScannerInput(');
	if (!createInput) {
		problems.push('extensionsScannerService.ts: не найдена createExtensionScannerInput()');
	} else {
		const resolvedLanguage = createInput.match(/const\s+(\w+)\s*=\s*language\s*\?\?\s*platform\.language/);
		if (!resolvedLanguage) {
			problems.push('createExtensionScannerInput(): язык сканирования не разрешается (`language ?? platform.language`), поэтому `input.language` может остаться undefined — кэш пишется по-английски, а проверочный скан локализован');
		} else {
			const inputCall = createInput.slice(createInput.indexOf('new ExtensionScannerInput('));
			if (!inputCall.includes(`${resolvedLanguage[1]},`)) {
				problems.push(`createExtensionScannerInput(): ExtensionScannerInput получает неразрешённый язык вместо ${resolvedLanguage[1]}`);
			}
		}
	}

	const validateCache = extractFunctionBody(source, 'private async validateCache(');
	if (!validateCache) {
		problems.push('extensionsScannerService.ts: не найдена validateCache()');
	} else if (!/ExtensionScannerInput\.equals\(\s*cacheContents\.input/.test(validateCache)) {
		problems.push('validateCache(): кэш чужого сканирования (другой язык/вход) сравнивается с текущим результатом — это даёт ложный «Invalidating Cache» и уведомление «Расширения были изменены на диске»');
	}

	return problems;
}

export function checkExtensionScanInvariants(root = ROOT) {
	return [...findDuplicateSettings(root), ...findScannerLanguageProblems(root)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = checkExtensionScanInvariants();
	if (problems.length) {
		console.error('FAIL: инварианты сканирования встроенных расширений нарушены:');
		for (const problem of problems) {
			console.error(`  - ${problem}`);
		}
		process.exit(1);
	}
	console.log('OK: повторных объявлений настроек нет; язык сканирования разрешается, кэш проверяется по своему входу.');
}
