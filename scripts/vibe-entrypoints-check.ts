#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Проверка «каждая точка входа сборки указывает на существующий исходник».
 *
 * Список точек входа живёт в двух файлах: build/next/index.ts (esbuild, он и упаковывает приложение)
 * и build/buildfile.ts (прежний путь). Когда исходник удаляют, а строка остаётся, сборка молча
 * не кладёт модуль в пакет, и ошибка всплывает только в логе запущенного приложения
 * (так выпали голосовой воркер в 1.9.0 и agentHostMain в 1.25.0).
 *
 * Использование:
 *   node scripts/vibe-entrypoints-check.ts
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');

/** Списки точек входа: build/next/index.ts (массивы `*EntryPoints`) и build/buildfile.ts (`createModuleDescription`). */
const NEXT_INDEX = 'build/next/index.ts';
const BUILDFILE = 'build/buildfile.ts';

/** Расширения, под которыми в src может лежать модуль точки входа. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js'];

/** Массив точек входа esbuild-пути: `const xxxEntryPoints... = [ ... ];`. */
const NEXT_ARRAY_PATTERN = /const\s+\w*EntryPoints\w*\s*=\s*\[([\s\S]*?)\n\];/g;

/** Точка входа вида `vs/...` в одинарных кавычках. */
const NEXT_ENTRY_PATTERN = /'(vs\/[^']+)'/g;

/** Точка входа в вызове `createModuleDescription('vs/...')`. */
const BUILDFILE_ENTRY_PATTERN = /createModuleDescription\(\s*'([^']+)'/g;

/** Строка без хвостового `//`-комментария: закомментированная точка входа проверке не подлежит. */
function stripLineComment(line: string): string {
	const at = line.indexOf('//');
	return at === -1 ? line : line.slice(0, at);
}

function sourceExists(entry: string): boolean {
	return SOURCE_EXTENSIONS.some(ext => fs.existsSync(path.join(ROOT, 'src', entry + ext)));
}

/** Точки входа в строках text; firstLine — номер первой строки text в файле. */
function* entriesIn(file: string, text: string, firstLine: number, pattern: RegExp): Generator<{ where: string; entry: string }> {
	const lines = text.split('\n');
	for (let index = 0; index < lines.length; index++) {
		for (const match of stripLineComment(lines[index]).matchAll(pattern)) {
			yield { where: `${file}:${firstLine + index}`, entry: match[1] };
		}
	}
}

const found: { where: string; entry: string }[] = [];

const nextText = fs.readFileSync(path.join(ROOT, NEXT_INDEX), 'utf8');
for (const array of nextText.matchAll(NEXT_ARRAY_PATTERN)) {
	const firstLine = nextText.slice(0, array.index ?? 0).split('\n').length;
	found.push(...entriesIn(NEXT_INDEX, array[0], firstLine, NEXT_ENTRY_PATTERN));
}

const buildfileText = fs.readFileSync(path.join(ROOT, BUILDFILE), 'utf8');
found.push(...entriesIn(BUILDFILE, buildfileText, 1, BUILDFILE_ENTRY_PATTERN));

const missing = found.filter(({ entry }) => !sourceExists(entry)).map(({ where, entry }) => `${where}  ${entry}`);

if (missing.length > 0) {
	console.error('Точки входа сборки без исходника в src/:');
	for (const item of missing) {
		console.error(`  ${item}`);
	}
	console.error('Убрать строку из списка или вернуть исходник.');
	process.exit(1);
}
console.log('vibe-entrypoints-check: все точки входа сборки указывают на существующие исходники');
