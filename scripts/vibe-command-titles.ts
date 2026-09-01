#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Палитра команд рисует `<категория>: <заголовок>` сама. Заголовок, повторяющий префикс, даёт
 * «VibeIDE: VibeIDE: Показать токен HTTP API» — так и жило 40 команд, пока это не попалось на
 * глаза при живом смоуке. Ошибка невидима для тайпчека и не проявляется нигде, кроме экрана.
 *
 * Проверяются `Action2`-команды в `contrib/vibeide`:
 *   1. заголовок не начинается с названия категории;
 *   2. команда, видимая в палитре (без `f1: false`), имеет категорию — иначе она висит в общем
 *      списке без группы;
 *   3. заголовок написан по-русски (правило «русский в исходнике»); английские слова внутри
 *      фразы допустимы — запрещён заголовок, где кириллицы нет вовсе;
 *   4. категория берётся из общей константы, а не собирается на месте. Литерал-объект и инлайновый
 *      `localize2('vibeCategory', 'VibeIDE')` работают ровно так же — до того дня, когда одна из
 *      36 копий разойдётся с остальными словом или регистром и палитра покажет две группы вместо
 *      одной. Один источник правды здесь дешевле любого соглашения.
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const AREA = path.join(ROOT, 'src', 'vs', 'workbench', 'contrib', 'vibeide');
const CATEGORY_PREFIXES = ['VibeIDE:', 'VibeIDE Diagnostics:'];

/** Titles that are a product or protocol name on purpose — Cyrillic would be wrong there. */
const LATIN_ALLOWED = new Set<string>([]);

function* sources(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'test') { continue; }
			yield* sources(full);
		} else if (entry.name.endsWith('.ts')) {
			yield full;
		}
	}
}

const problems: string[] = [];
for (const file of sources(AREA)) {
	const text = fs.readFileSync(file, 'utf8');
	const rel = path.relative(ROOT, file);
	// Action2 descriptors: super({ … }) — the body is small, so a bounded match is enough.
	for (const block of text.matchAll(/super\(\{(.{0,1400}?)\}\);/gs)) {
		const body = block[1];
		const title = body.match(/title:\s*localize2\(\s*'[^']*'\s*,\s*'([^']*)'/);
		if (!title) { continue; }
		const value = title[1];
		const inPalette = !/f1:\s*false/.test(body);
		const prefix = CATEGORY_PREFIXES.find(p => value.startsWith(p));
		if (prefix) {
			problems.push(`${rel}: заголовок повторяет категорию — «${value}». Палитра склеит её сама, префикс из title убрать`);
		}
		if (inPalette && !/(^|[\s{,])category\s*[,:]/.test(body)) {
			problems.push(`${rel}: команда «${value}» видна в палитре без категории — добавить category: VIBE_COMMAND_CATEGORY`);
		}
		if (inPalette && !/[а-яё]/i.test(value) && !LATIN_ALLOWED.has(value)) {
			problems.push(`${rel}: заголовок «${value}» не по-русски — пользовательские строки пишутся на русском сразу в исходнике`);
		}
		const category = body.match(/category:\s*([^,\n]+)/);
		if (category && !/^VIBE_[A-Z_]*CATEGORY$/.test(category[1].trim()) && !/Categories\./.test(category[1])) {
			problems.push(`${rel}: категория «${category[1].trim()}» собрана на месте — берите VIBE_COMMAND_CATEGORY из common/vibeCommandCategory.ts`);
		}
	}
}

if (problems.length) {
	console.error('❌ Заголовки команд:');
	for (const p of problems) { console.error(`   ${p}`); }
	console.error(`\n   всего: ${problems.length}`);
	process.exit(1);
}
console.log('✅ Заголовки команд: категория не дублируется, палитра сгруппирована, строки русские.');
