#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Проверка оверлея форка после обновления базы VS Code.
 *
 * Обновление базы — единственная операция, которая может молча стереть нашу работу: наш код живёт
 * не только в своих файлах, но и сотнями правок внутри апстримных. Компиляция такую потерю не
 * ловит — код без нашего хука собирается прекрасно, просто фича исчезает.
 *
 * Проверяются три инварианта:
 *   1. Наши собственные файлы на месте и не изменены слиянием (blob-в-blob).
 *   2. Каждая строка, добавленная нами поверх базы, присутствует после слияния.
 *   3. Ни одна строка, удалённая нами из апстрима (вырезки вендорных поверхностей), не воскресла.
 *
 * Ожидаемые расхождения (код переехал в другой файл, наш шим заменён апстримным аналогом)
 * объявляются в `build/upstreamOverlayExpectedDrops.txt` — с обязательной причиной.
 *
 * Использование:
 *   node scripts/vibe-upstream-overlay-check.mjs --base <sha базы> --before <sha до слияния> [--after HEAD]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_DROPS = path.join(ROOT, 'build', 'upstreamOverlayExpectedDrops.txt');

/** Строки, «пропажа» которых ничего не значит: пустые, скобки, служебные. */
const NOISE = new Set(['', '{', '}', '});', '};', ')', '(', '*/', '/*', '*', '],', '},', '})', '];', '/**', 'return;', 'break;']);

function git(args) {
	return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function tryGit(args) {
	try { return git(args); } catch { return undefined; }
}

function argValue(name, fallback) {
	const i = process.argv.indexOf(name);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = argValue('--base');
const BEFORE = argValue('--before');
const AFTER = argValue('--after', 'HEAD');

if (!BASE || !BEFORE) {
	console.error('Нужны --base <sha апстримной базы> и --before <sha нашего состояния до слияния>.');
	console.error('Пример: node scripts/vibe-upstream-overlay-check.mjs --base 034f571d --before 4e412aaa');
	process.exit(2);
}

/** Карта путь → blob для ревизии. */
function treeOf(rev) {
	const out = git(['ls-tree', '-r', rev]);
	const map = new Map();
	for (const line of out.split('\n')) {
		if (!line) { continue; }
		const [meta, file] = line.split('\t');
		map.set(file, meta.split(' ')[2]);
	}
	return map;
}

function loadExpectedDrops() {
	if (!fs.existsSync(EXPECTED_DROPS)) { return []; }
	const rows = [];
	for (const line of fs.readFileSync(EXPECTED_DROPS, 'utf8').split('\n')) {
		if (!line.trim() || line.startsWith('#')) { continue; }
		const [file, needle, reason] = line.split('\t');
		if (!file || !needle) { continue; }
		if (!reason || !reason.trim()) {
			console.error(`✗ В ${path.relative(ROOT, EXPECTED_DROPS)} запись без причины: ${file} / ${needle}`);
			process.exitCode = 1;
			continue;
		}
		rows.push({ file: file.trim(), needle: needle.trim() });
	}
	return rows;
}

const expectedDrops = loadExpectedDrops();
/** `*` в реестре объявляет файл целиком; иначе сверяется подстрока. */
const excused = (file, line) => expectedDrops.some(d => d.file === file && (d.needle === '*' || line.includes(d.needle)));

const treeBefore = treeOf(BEFORE);
const treeAfter = treeOf(AFTER);
const treeBase = treeOf(BASE);

// --- Инвариант 1: наши собственные файлы -------------------------------------
const ourOwnFiles = [...treeBefore.keys()].filter(f => !treeBase.has(f));
const lost = ourOwnFiles.filter(f => !treeAfter.has(f));
const mutated = ourOwnFiles.filter(f => treeAfter.has(f) && treeAfter.get(f) !== treeBefore.get(f));

// --- Инварианты 2 и 3: наши правки внутри апстримных файлов -------------------
const overlayFiles = [...treeBefore.keys()].filter(f => treeBase.has(f) && treeBefore.get(f) !== treeBase.get(f) && !f.endsWith('package-lock.json'));

const missingAdded = [];
const resurrected = [];

for (const file of overlayFiles) {
	const diff = tryGit(['diff', '-U0', '--no-color', BASE, BEFORE, '--', file]) ?? '';
	const added = [];
	const removed = [];
	for (const line of diff.split('\n')) {
		if (line.startsWith('+') && !line.startsWith('+++')) { added.push(line.slice(1)); }
		else if (line.startsWith('-') && !line.startsWith('---')) { removed.push(line.slice(1)); }
	}
	const after = tryGit(['show', `${AFTER}:${file}`]);
	if (after === undefined) {
		// файл удалён после слияния — это осознанное решение, оно объявляется в реестре
		if (!expectedDrops.some(d => d.file === file)) {
			missingAdded.push({ file, line: '<файл отсутствует после слияния>' });
		}
		continue;
	}
	// JSON сравнивается по содержимому, а не построчно: файл могли переформатировать
	// (пересборка package.json), и тогда построчная сверка даёт сплошной ложный сигнал.
	if (file.endsWith('.json')) {
		const flatten = (text) => {
			const acc = new Set();
			let parsed;
			try { parsed = JSON.parse(text); } catch { return undefined; }
			const walk = (node, trail) => {
				if (node && typeof node === 'object') {
					for (const [k, v] of Object.entries(node)) { walk(v, trail ? `${trail}.${k}` : k); }
				} else {
					acc.add(`${trail}=${JSON.stringify(node)}`);
				}
			};
			walk(parsed, '');
			return acc;
		};
		const beforeSet = flatten(tryGit(['show', `${BEFORE}:${file}`]) ?? '');
		const baseSet = flatten(tryGit(['show', `${BASE}:${file}`]) ?? '');
		const afterSet = flatten(after);
		if (beforeSet && baseSet && afterSet) {
			for (const entry of beforeSet) {
				if (!baseSet.has(entry) && !afterSet.has(entry) && !excused(file, entry)) {
					missingAdded.push({ file, line: entry });
				}
			}
			for (const entry of baseSet) {
				if (!beforeSet.has(entry) && afterSet.has(entry) && !excused(file, entry)) {
					resurrected.push({ file, line: entry });
				}
			}
			continue;
		}
	}

	const afterList = after.split('\n').map(l => l.trim());
	const afterLines = new Set(afterList);

	// Сколько раз строка встречалась в исходном файле. Строка, которая была там не одна
	// (`with:`, `runs-on: ubuntu-22.04`, `steps:`), ничего не доказывает: её «возвращение» —
	// это соседний блок, а не воскресшая вырезка. Такие строки проверяем только на добавление.
	const beforeText = tryGit(['show', `${BEFORE}:${file}`]) ?? '';
	const occurrences = new Map();
	for (const l of beforeText.split('\n')) {
		const t = l.trim();
		occurrences.set(t, (occurrences.get(t) ?? 0) + 1);
	}
	const baseText = tryGit(['show', `${BASE}:${file}`]) ?? '';
	const baseOccurrences = new Map();
	for (const l of baseText.split('\n')) {
		const t = l.trim();
		baseOccurrences.set(t, (baseOccurrences.get(t) ?? 0) + 1);
	}

	const meaningful = t => !NOISE.has(t) && t.length > 3 && !/^[-\s]*$/.test(t);

	for (const line of added) {
		const t = line.trim();
		if (!meaningful(t)) { continue; }
		if (!afterLines.has(t) && !excused(file, line)) { missingAdded.push({ file, line: t }); }
	}
	for (const line of removed) {
		const t = line.trim();
		if (!meaningful(t)) { continue; }
		// Вырезка засчитывается воскресшей, только если строка была уникальной в базе:
		// иначе мы ловим не возврат нашей правки, а однотипный соседний код.
		if ((baseOccurrences.get(t) ?? 0) !== 1) { continue; }
		if (afterLines.has(t) && !excused(file, line)) { resurrected.push({ file, line: t }); }
	}
}

// --- Отчёт -------------------------------------------------------------------
// `--all` печатает список целиком: при разборе итогов слияния усечённый вывод скрывает
// как раз то, ради чего проверка существует.
const LIMIT = process.argv.includes('--all') ? Number.POSITIVE_INFINITY : 25;

const report = (title, rows, render) => {
	console.log(`\n${rows.length === 0 ? '✅' : '❌'} ${title}: ${rows.length}`);
	for (const r of rows.slice(0, LIMIT)) { console.log('   ' + render(r)); }
	if (rows.length > LIMIT) { console.log(`   … и ещё ${rows.length - LIMIT}`); }
};

console.log('🧩 Проверка оверлея форка после обновления базы');
console.log('─'.repeat(60));
console.log(`база ${BASE} → наше состояние ${BEFORE} → результат ${AFTER}`);
console.log(`наших файлов: ${ourOwnFiles.length}, апстримных с нашими правками: ${overlayFiles.length}`);

report('Наши файлы, пропавшие при слиянии', lost, f => f);
report('Наши файлы, изменённые слиянием', mutated, f => f);
report('Наши добавленные строки, не найденные в результате', missingAdded, r => `${r.file}: ${r.line.slice(0, 120)}`);
report('Наши вырезки, воскресшие в результате', resurrected, r => `${r.file}: ${r.line.slice(0, 120)}`);

const failed = lost.length + mutated.length + missingAdded.length + resurrected.length;
if (failed === 0) {
	console.log('\n✅ Оверлей форка перенесён полностью.');
} else {
	console.log(`\n❌ Расхождений: ${failed}. Каждое — либо потеря нашей работы, либо возврат вырезанного;`);
	console.log('   осознанные переезды объявляются в build/upstreamOverlayExpectedDrops.txt с причиной.');
}
process.exit(failed > 0 ? 1 : (process.exitCode ?? 0));
