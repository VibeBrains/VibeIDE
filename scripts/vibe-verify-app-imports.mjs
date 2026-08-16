#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Проверка, что собранное приложение найдёт свои зависимости при запуске.
 *
 * Главный процесс — ESM, а резолвер ESM в Node не умеет заглядывать внутрь ASAR-архива.
 * Поэтому пакет, уехавший в архив вместо обычной папки, ломает запуск сразу и целиком:
 * «Cannot find package …» в первом же окне. Компиляция такого не ловит, и обычный смоук
 * `--version` тоже — консольный путь до этих импортов не доходит.
 *
 * Проверка вытаскивает из бандлов главного процесса все внешние импорты и убеждается, что
 * каждый лежит распакованным.
 *
 * Использование:
 *   node scripts/vibe-verify-app-imports.mjs <путь к .app или к каталогу resources/app>
 */

import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';

const target = process.argv[2];
if (!target) {
	console.error('Укажите путь к собранному приложению (.app) или к его каталогу resources/app.');
	process.exit(2);
}

const appRoot = fs.existsSync(path.join(target, 'Contents', 'Resources', 'app'))
	? path.join(target, 'Contents', 'Resources', 'app')
	: target;

if (!fs.existsSync(path.join(appRoot, 'package.json'))) {
	console.error(`Не похоже на собранное приложение: ${appRoot}`);
	process.exit(2);
}

/** Файлы, которые Node загружает как ESM напрямую — их импорты обязаны резолвиться с диска. */
const ENTRY_FILES = ['out/main.js', 'out/bootstrap-fork.js', 'out/server-main.js'];

const BUILTIN = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

/** Виртуальные модули Electron: их предоставляет рантайм, на диске их нет. */
const ELECTRON_PROVIDED = new Set(['electron', 'original-fs']);

/**
 * Пакеты, которые ставятся только под свою ОС (optionalDependencies). На чужой платформе
 * их отсутствие — норма, а не поломка сборки.
 */
const PLATFORM_ONLY = [
	{ match: /^@vscode\/windows-|^windows-|^@vscode\/spdlog$/, platform: 'win32' },
	{ match: /^@vscode\/macos-/, platform: 'darwin' },
];

/** Спецификатор, собранный из переменных (`'pkg' + x`), статически не проверяем. */
const isLiteralSpecifier = spec => /^(@[\w.-]+\/)?[\w.-]+(\/[\w.-]+)*$/.test(spec);
const nodeModulesDir = path.join(appRoot, 'node_modules');
const unpackedDir = path.join(appRoot, 'node_modules.asar.unpacked');

/** Имя пакета из спецификатора: `@scope/name/sub` → `@scope/name`. */
function packageOf(spec) {
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function externalImportsOf(file) {
	const source = fs.readFileSync(file, 'utf8');
	const specs = new Set();
	const patterns = [
		/\bfrom\s+["']([^"'.][^"']*)["']/g,      // import … from 'pkg'
		/\bimport\s*\(\s*["']([^"'.][^"']*)["']/g, // import('pkg')
		/\brequire\s*\(\s*["']([^"'.][^"']*)["']/g, // require('pkg')
	];
	for (const re of patterns) {
		let m;
		while ((m = re.exec(source)) !== null) {
			const spec = m[1];
			if (BUILTIN.has(spec) || ELECTRON_PROVIDED.has(spec) || spec.startsWith('vs/')) { continue; }
			if (!isLiteralSpecifier(spec)) { continue; }
			const pkg = packageOf(spec);
			const platformOnly = PLATFORM_ONLY.find(p => p.match.test(pkg));
			if (platformOnly && platformOnly.platform !== process.platform) { continue; }
			specs.add(pkg);
		}
	}
	return specs;
}

const missing = [];
const checked = [];

/**
 * Ресурсы, которые код грузит из `node_modules` по пути, вычисленному в рантайме. Апстрим
 * выводит его из «это собранное приложение» и попадает в распакованный архив; форк раскладывает
 * зависимости обычными файлами. Промах здесь не роняет запуск — он тихо выключает целую
 * подсистему (подсветку синтаксиса), поэтому проверяется отдельно.
 */
const RUNTIME_RESOURCES = [
	['vscode-oniguruma/release/onig.wasm', 'движок токенизации — без него пропадает подсветка синтаксиса'],
	['@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm', 'tree-sitter — разбор кода для подсветки и структуры'],
];

const hasUnpackedDir = fs.existsSync(unpackedDir);

for (const [rel, why] of RUNTIME_RESOURCES) {
	const inPlain = fs.existsSync(path.join(nodeModulesDir, rel));
	const inUnpacked = hasUnpackedDir && fs.existsSync(path.join(unpackedDir, rel));
	if (!inPlain && !inUnpacked) {
		missing.push({ entry: `ресурс: ${why}`, pkg: rel });
	}
}

// Мало, чтобы ресурс просто существовал: важно, что код ищет его там, где он лежит. Апстрим
// вычисляет путь как «собранное приложение → распакованный архив»; если этой директории в сборке
// нет, а бандл всё ещё на неё ссылается, подсистема молча отключится.
if (!hasUnpackedDir) {
	const bundles = ['out/vs/workbench/workbench.desktop.main.js', 'out/vs/code/electron-browser/workbench/workbench.js'];
	for (const rel of bundles) {
		const file = path.join(appRoot, rel);
		if (!fs.existsSync(file)) { continue; }
		if (fs.readFileSync(file, 'utf8').includes('node_modules.asar.unpacked')) {
			missing.push({
				entry: `${rel} ссылается на node_modules.asar.unpacked`,
				pkg: 'раскладка модулей',
			});
		}
	}
}

for (const rel of ENTRY_FILES) {
	const file = path.join(appRoot, rel);
	if (!fs.existsSync(file)) { continue; }
	for (const pkg of externalImportsOf(file)) {
		const resolvable = fs.existsSync(path.join(nodeModulesDir, pkg))
			|| fs.existsSync(path.join(unpackedDir, pkg));
		checked.push(pkg);
		if (!resolvable) {
			missing.push({ entry: rel, pkg });
		}
	}
}

console.log('📦 Проверка зависимостей собранного приложения');
console.log('─'.repeat(60));
console.log(`приложение: ${appRoot}`);
console.log(`проверено импортов: ${new Set(checked).size}`);

if (missing.length === 0) {
	console.log('\n✅ Все внешние импорты главного процесса разрешаются с диска.');
	process.exit(0);
}

console.log(`\n❌ Не найдены распакованными: ${missing.length}`);
for (const m of missing) {
	console.log(`   ${m.pkg}  (импортирует ${m.entry})`);
}
console.log('\nПри запуске это даст «Cannot find package …» в главном процессе.');
console.log('Обычно причина в том, что пакет уехал в node_modules.asar: резолвер ESM внутрь архива не смотрит.');
process.exit(1);
