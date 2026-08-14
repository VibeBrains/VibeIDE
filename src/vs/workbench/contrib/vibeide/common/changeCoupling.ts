/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Скрытая связанность и история починок — из git-истории, без единого вызова модели.
 *
 * Граф импортов отвечает, что от чего ЗАВИСИТ. Он молчит о паре файлов, которые двадцать раз
 * меняли вместе и ни разу по отдельности, потому что между ними нет ни одной строки кода — есть
 * договорённость, живущая в голове. Такую пару видно только в истории коммитов, и именно она даёт
 * самый частый класс поломки: правку внесли в один файл из пары, а про второй забыли.
 *
 * Второй сигнал — не «часто меняется», а «часто ЧИНЯТ». Частая правка обычно означает лишь то, что
 * здесь идёт работа. Частая починка означает, что здесь ломается, и это разные утверждения о файле.
 *
 * Два решения, ради которых модуль существует:
 *
 *  1. **Массовый коммит не создаёт связанности.** Коммит, тронувший сорок файлов (переименование,
 *     обновление зависимости, автоформат), связывает каждый файл с каждым — 780 «пар», ни одна из
 *     которых ничего не значит. Такие коммиты в подсчёт пар не идут вовсе.
 *  2. **Багфиксом считается не слово в заголовке, а форма коммита.** Половина коммитов `fix:`
 *     правит опечатку в README или подкручивает тест. Если считать их, «файл, который часто чинят»
 *     превращается в «файл, который часто упоминают», и сигнал пропадает.
 *
 * Чистый модуль: git вызывает слой выше, сюда приходит уже прочитанный текст.
 */

import { localize } from '../../../../nls.js';

/** Один коммит истории в том виде, в каком его достаточно для анализа. */
export interface ICommitRecord {
	readonly hash: string;
	readonly subject: string;
	readonly whenMs: number;
	/** Пути, затронутые коммитом, относительно корня репозитория. */
	readonly files: readonly string[];
}

export interface ICouplingThresholds {
	/**
	 * Коммит, тронувший больше файлов, в подсчёте пар не участвует.
	 *
	 * Ровно эти коммиты и создают ложную связанность: переименования, автоформат, обновление
	 * зависимостей. Они связывают всё со всем, а значит — ничего ни с чем.
	 */
	readonly maxFilesPerCommit: number;
	/** Сколько раз пара должна встретиться вместе, чтобы считаться связанной. */
	readonly minPairCommits: number;
	/** Доля совместных правок от правок первого файла, ниже которой это совпадение, а не связь. */
	readonly minPairRatio: number;
	/** Окно истории починок в днях. */
	readonly bugWindowDays: number;
}

export const DEFAULT_COUPLING_THRESHOLDS: ICouplingThresholds = {
	maxFilesPerCommit: 20,
	minPairCommits: 3,
	minPairRatio: 0.3,
	bugWindowDays: 180,
};

export interface ICouplingPair {
	readonly file: string;
	/** Сколько раз менялись в одном коммите. */
	readonly together: number;
	/** Доля от числа коммитов, где менялся исходный файл. */
	readonly ratio: number;
}

export interface IBugHistory {
	readonly file: string;
	/** Сколько починок за окно. */
	readonly fixes: number;
	/** Сколько дней назад чинили в последний раз; `undefined` — не чинили за окно. */
	readonly lastFixDaysAgo?: number;
}

/**
 * Заголовки, похожие на починку. Кандидат, а не факт: форму проверяем отдельно.
 *
 * Русская часть вынесена из `\b`-группы намеренно: `\w` и `\b` в JavaScript определены по латинице,
 * поэтому `\bисправ\w*\b` не совпадает ни с чем — русские коммиты молча не считались бы вовсе.
 * «Фикс» в список не входит: он ловит «фиксация», а фиксация сделанного — не починка.
 */
const FIX_SUBJECT_PATTERN = /\b(fix(e[sd])?|bug ?fix|hotfix|patch|repair)\b|^fix(\(|:)|(исправ|почин|устран)[а-яё]*/i;

/** Пути, изменение которых само по себе починкой кода не является. */
const NON_CODE_PATTERN = /(^|\/)(docs?|documentation)\//i;
const NON_CODE_EXT_PATTERN = /\.(md|mdx|rst|txt|adoc|json|ya?ml|toml|lock|cfg|ini|svg|png|jpe?g|gif|ico)$/i;
const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec)\//i;
const TEST_FILE_PATTERN = /(\.(test|spec)\.[a-z]+|_test\.[a-z]+|^test_[^/]*\.[a-z]+)$/i;

/**
 * Является ли путь исходным кодом продукта.
 *
 * Тесты и документация исключены не потому, что они неважны, а потому, что коммит, поправивший
 * только их, не свидетельствует о поломке В КОДЕ — а именно это утверждение мы собираемся сделать.
 */
export function isProductCode(file: string): boolean {
	if (!file) { return false; }
	if (NON_CODE_PATTERN.test(file) || NON_CODE_EXT_PATTERN.test(file)) { return false; }
	// `test_x.py` проверяется по имени файла, а не по всему пути — иначе каталог `test_utils/`
	// увёл бы под фильтр весь лежащий в нём продуктовый код.
	const name = file.slice(file.lastIndexOf('/') + 1);
	if (TEST_PATH_PATTERN.test(file) || TEST_FILE_PATTERN.test(name)) { return false; }
	return true;
}

/**
 * Считается ли коммит починкой кода.
 *
 * Двухступенчато: сперва заголовок (кандидат), затем состав (факт). Коммит `fix:`, тронувший одни
 * доки или одни тесты, починкой кода не признаётся — иначе счётчик меряет частоту слова, а не
 * частоту поломок.
 */
export function isCodeFix(commit: ICommitRecord): boolean {
	if (!FIX_SUBJECT_PATTERN.test(commit.subject)) { return false; }
	return commit.files.some(isProductCode);
}

/**
 * Файлы, которые исторически меняются вместе с указанными.
 *
 * Возвращаются только те, которых НЕТ во входном наборе: вопрос, ради которого это считается, —
 * «что вы забыли тронуть», а не «что вы тронули».
 */
export function coupledWith(
	commits: readonly ICommitRecord[],
	files: readonly string[],
	thresholds: ICouplingThresholds = DEFAULT_COUPLING_THRESHOLDS,
): ICouplingPair[] {
	const target = new Set(files.filter(Boolean));
	if (target.size === 0) { return []; }

	let targetCommits = 0;
	const together = new Map<string, number>();
	for (const commit of commits) {
		if (commit.files.length > thresholds.maxFilesPerCommit) { continue; }
		const touched = commit.files.filter(file => target.has(file));
		if (touched.length === 0) { continue; }
		targetCommits += 1;
		for (const file of commit.files) {
			if (target.has(file)) { continue; }
			together.set(file, (together.get(file) ?? 0) + 1);
		}
	}
	if (targetCommits === 0) { return []; }

	return [...together.entries()]
		.map(([file, count]) => ({ file, together: count, ratio: count / targetCommits }))
		.filter(pair => pair.together >= thresholds.minPairCommits && pair.ratio >= thresholds.minPairRatio)
		// Сильнейшая связь первой: список читает модель, и первые строки она взвешивает выше.
		.sort((a, b) => b.ratio - a.ratio || b.together - a.together || a.file.localeCompare(b.file));
}

/**
 * История починок по файлам за окно.
 *
 * `nowMs` передаётся, а не берётся из часов: чистая функция, которая смотрит на время сама,
 * непроверяема — её результат меняется от того, когда запустили тест.
 */
export function bugHistory(
	commits: readonly ICommitRecord[],
	files: readonly string[],
	nowMs: number,
	thresholds: ICouplingThresholds = DEFAULT_COUPLING_THRESHOLDS,
): IBugHistory[] {
	const windowMs = thresholds.bugWindowDays * 24 * 60 * 60 * 1000;
	const wanted = new Set(files.filter(Boolean));
	const fixes = new Map<string, { count: number; lastMs: number }>();

	for (const commit of commits) {
		if (nowMs - commit.whenMs > windowMs) { continue; }
		if (!isCodeFix(commit)) { continue; }
		for (const file of commit.files) {
			if (!wanted.has(file) || !isProductCode(file)) { continue; }
			const entry = fixes.get(file);
			if (entry) {
				entry.count += 1;
				entry.lastMs = Math.max(entry.lastMs, commit.whenMs);
			} else {
				fixes.set(file, { count: 1, lastMs: commit.whenMs });
			}
		}
	}

	return [...wanted]
		.map(file => {
			const entry = fixes.get(file);
			return entry
				? { file, fixes: entry.count, lastFixDaysAgo: Math.floor((nowMs - entry.lastMs) / (24 * 60 * 60 * 1000)) }
				: { file, fixes: 0 };
		})
		.filter(entry => entry.fixes > 0)
		.sort((a, b) => b.fixes - a.fixes || a.file.localeCompare(b.file));
}

/**
 * Разбор вывода `git log --name-only --date=unix --pretty=%H%x00%at%x00%s`.
 *
 * Формат с NUL-разделителем выбран потому, что заголовок коммита может содержать что угодно,
 * включая табуляции и вертикальные черты; NUL в нём появиться не может.
 */
export function parseCommitLog(text: string): ICommitRecord[] {
	const commits: ICommitRecord[] = [];
	let current: { hash: string; subject: string; whenMs: number; files: string[] } | undefined;
	for (const line of (text ?? '').split(/\r?\n/)) {
		if (line.includes('\0')) {
			if (current) { commits.push(current); }
			const [hash, at, ...rest] = line.split('\0');
			const seconds = Number(at);
			current = {
				hash: hash.trim(),
				subject: rest.join('\0').trim(),
				whenMs: Number.isFinite(seconds) ? seconds * 1000 : 0,
				files: [],
			};
			continue;
		}
		const path = line.trim();
		if (!path || !current) { continue; }
		current.files.push(path);
	}
	if (current) { commits.push(current); }
	return commits;
}

/**
 * Пути из вывода `git diff --stat`.
 *
 * Разбор терпимый и намеренно консервативный: строка итога (`3 files changed, …`) отбрасывается,
 * сокращённые пути с `...` внутри — тоже. Ошибиться в пути хуже, чем его пропустить: пара,
 * построенная на выдуманном имени файла, уводит агента в несуществующий файл.
 */
export function changedFilesFromStat(text: string): string[] {
	const files: string[] = [];
	for (const line of (text ?? '').split(/\r?\n/)) {
		const match = /^\s*(\S[^|]*?)\s*\|\s+\d+/.exec(line);
		if (!match) { continue; }
		const path = match[1].trim();
		if (!path || path.includes('...') || path.includes('=>')) { continue; }
		files.push(path);
	}
	return files;
}

/**
 * Человекочитаемая сводка для агента.
 *
 * Формулировка намеренно осторожная: совместное изменение — это КОРРЕЛЯЦИЯ, а не обязанность.
 * Сказать «нужно исправить и эти файлы» значит выдать статистику за факт о коде.
 */
export function renderCoupling(pairs: readonly ICouplingPair[], bugs: readonly IBugHistory[]): string {
	const parts: string[] = [];
	if (pairs.length > 0) {
		const rows = pairs.map(pair => `- ${pair.file} — вместе ${pair.together} раз (${Math.round(pair.ratio * 100)}% правок)`);
		parts.push(`${localize('vibeide.coupling.pairs', "Обычно меняются вместе с этими файлами, но сейчас не тронуты:")}\n${rows.join('\n')}`);
	}
	if (bugs.length > 0) {
		const rows = bugs.map(bug => {
			const last = bug.lastFixDaysAgo === undefined ? '' : `, последняя ${bug.lastFixDaysAgo} дн. назад`;
			return `- ${bug.file} — починок ${bug.fixes}${last}`;
		});
		parts.push(`${localize('vibeide.coupling.bugs', "История починок за окно:")}\n${rows.join('\n')}`);
	}
	if (parts.length === 0) {
		return localize('vibeide.coupling.none', "История не показывает ни устойчивых пар, ни починок по этим файлам.");
	}
	return parts.join('\n\n');
}
