#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Охранная проверка без зависимостей: встроенные расширения не объявляют настройки,
// которые workbench уже регистрирует в `src/vs/workbench/contrib/vibeide/**`
// Второе объявление заставляет `vibeide-neon` писать при каждом старте
// «Невозможно зарегистрировать "<key>". Это свойство уже зарегистрировано.»
// Язык сканирования и общий кэш манифестов покрыты тестом `extensionsScannerService.test.ts`
//
// Запуск: `node scripts/check-extension-scan-invariants.mts`, при находках код выхода ненулевой

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

export function checkExtensionScanInvariants(root = ROOT) {
	return findDuplicateSettings(root);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const problems = checkExtensionScanInvariants();
	if (problems.length) {
		console.error('FAIL: настройки встроенных расширений дублируют настройки ядра:');
		for (const problem of problems) {
			console.error(`  - ${problem}`);
		}
		process.exit(1);
	}
	console.log('OK: повторных объявлений настроек нет.');
}
