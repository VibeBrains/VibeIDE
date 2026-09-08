/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Гейт: в засеваемых файлах провайдеров нет полей, которых продукт не читает.
 *
 * Разбор `.vibe/providers.json` намеренно ИГНОРИРУЕТ незнакомые поля — иначе файл, написанный под
 * более новую версию, ронял бы весь набор. Цена этого решения обнаружилась 08.09.2026: сид с
 * `pricing` / `priceValidUntil` вместо `cost` / `costValidUntil` прошёл любую проверку синтаксиса,
 * засеялся в проект — и не объявил ничего. Файл выглядел рабочим, потому что молчание разборщика
 * неотличимо от «всё в порядке».
 *
 * Поэтому здесь проверяется то, что разборщик проверять не должен: каждое поле в сиде обязано быть
 * И в типе (`common/vibeProvidersFile.ts`), И в спеке (`docs/manuals/providersSpec.md`). Два
 * источника, а не один, ровно по проектному правилу «поле формата считается сделанным, когда оно
 * есть в типе, схеме и спеке»: поле, дошедшее только до кода, нельзя ни найти, ни объяснить модели,
 * а поле, дошедшее только до спеки, не работает.
 */

// `scripts/package.json` pins CommonJS, so this file uses require() like its neighbours.
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const ROOT = path.join(__dirname, '..');
const SEEDS_DIR = path.join(ROOT, '.vibe-defaults', 'providers');
const TYPES_FILE = path.join(ROOT, 'src/vs/workbench/contrib/vibeide/common/vibeProvidersFile.ts');
const SPEC_FILE = path.join(ROOT, 'docs/manuals/providersSpec.md');

/** Strip `//` comments without touching the ones inside strings (every seed carries URLs). */
function stripComments(source: string): string {
	let out = '';
	let inString = false;
	let escaped = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (inString) {
			out += c;
			if (escaped) { escaped = false; } else if (c === '\\') { escaped = true; } else if (c === '"') { inString = false; }
			continue;
		}
		if (c === '"') { inString = true; out += c; continue; }
		if (c === '/' && source[i + 1] === '/') {
			while (i < source.length && source[i] !== '\n') { i++; }
			out += '\n';
			continue;
		}
		out += c;
	}
	return out;
}

/** Check the keys of one entry — a provider or a model — against type and spec. */
function checkEntry(entry: unknown, where: string, types: string, spec: string, problems: string[]): number {
	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		return 0;
	}
	let checked = 0;
	for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
		if (key === 'models') {
			continue; // handled by the caller, which knows the models sub-shape
		}
		// Only the names of the entry's OWN fields are ours to judge. What sits inside `extraBody`,
		// `headers`, `query` or `env` is vendor vocabulary passed through verbatim — not knowing those
		// names is the entire point of those fields — and the shapes inside `cost` or `auth` are
		// documented in the parent's spec row rather than as rows of their own.
		checked++;
		// `readonly key?:` in the type, and the key in a spec table cell — both are how a field is
		// written in those files, and both are cheap to check without parsing TypeScript or Markdown.
		// The key comes from a hand-written file, so it is escaped before it becomes a pattern: a
		// stray `.` would match anything and a stray `[` would throw, taking the gate down with it.
		const inType = new RegExp(`readonly\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\??\\s*:`).test(types);
		const inSpec = spec.includes(`\`${key}\``);
		if (!inType && !inSpec) {
			problems.push(`${where}: поле «${key}» не знает ни тип, ни спека — продукт молча его отбросит`);
		} else if (!inType) {
			problems.push(`${where}: поле «${key}» есть в спеке, но не в типе — читать его некому`);
		} else if (!inSpec) {
			problems.push(`${where}: поле «${key}» есть в типе, но не в спеке — модель о нём не узнает`);
		}
	}
	return checked;
}

function main(): void {
	if (!fs.existsSync(SEEDS_DIR)) {
		// The submodule is not checked out — nothing to verify, and failing here would break a
		// clone that simply has not run `git submodule update` yet.
		console.log('ℹ️  Набор сидов не выгружен (.vibe-defaults) — проверка полей пропущена.');
		return;
	}

	const types = fs.readFileSync(TYPES_FILE, 'utf8');
	const spec = fs.readFileSync(SPEC_FILE, 'utf8');

	const problems: string[] = [];
	let filesChecked = 0;
	let keysChecked = 0;

	for (const name of fs.readdirSync(SEEDS_DIR).sort()) {
		if (!name.endsWith('.jsonc') && !name.endsWith('.json')) {
			continue;
		}
		const file = path.join(SEEDS_DIR, name);
		const raw = fs.readFileSync(file, 'utf8');
		let parsed: unknown;
		try {
			parsed = JSON.parse(stripComments(raw));
		} catch (err) {
			problems.push(`${name}: не разбирается как JSONC — ${(err as Error).message}`);
			continue;
		}
		filesChecked++;

		const providers = (parsed as { providers?: unknown }).providers;
		if (!Array.isArray(providers)) {
			problems.push(`${name}: нет массива providers — файл не будет прочитан вовсе`);
			continue;
		}
		for (const provider of providers) {
			const id = (provider as { id?: unknown })?.id;
			const label = `${name} → ${typeof id === 'string' ? id : '?'}`;
			keysChecked += checkEntry(provider, label, types, spec, problems);
			const models = (provider as { models?: { static?: unknown } })?.models;
			for (const model of Array.isArray(models?.static) ? models.static : []) {
				const modelId = (model as { id?: unknown })?.id;
				keysChecked += checkEntry(model, `${label}/${typeof modelId === 'string' ? modelId : '?'}`, types, spec, problems);
			}
		}
	}

	if (problems.length > 0) {
		console.error('❌ Поля в наборе сидов, которых продукт не читает:\n');
		for (const problem of problems) {
			console.error(`   • ${problem}`);
		}
		console.error('\nРазбор providers.json игнорирует незнакомые поля намеренно, поэтому такой сид');
		console.error('выглядит рабочим и не делает ничего. Переименуйте поле или доведите его до типа и спеки.');
		process.exit(1);
	}

	console.log(`✅ Набор сидов: ${filesChecked} файл(ов), ${keysChecked} полей — все известны типу и спеке.`);
}

main();
