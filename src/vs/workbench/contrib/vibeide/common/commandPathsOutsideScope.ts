/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Пути в аргументах команды, которые лежат вне проекта
 *
 * WHY: проверки записи смотрели на путь инструмента правки, а у `run_command` пути нет —
 * только строка. Абсолютный путь в аргументе (`--save /Volumes`) при этом никто не читал:
 * `commandEscapesScope` ловит смену папки и перенаправление git, `analyzeShellLine` — известные
 * разрушительные программы. Скрипт, который сам чистит каталог из `--save`, оставался невидимым
 *
 * Разбор намеренно грубый: аргументы любой программы, включая значение опции (`--opt=/path`,
 * `-o/path`). Что программа делает с путём, решает вызывающий: здесь только «путь вне проекта»
 *
 * Чистая: без файловой системы, окружения и платформы
 */

import { splitShellSegments } from './nlShellSafetyAnalyzer.js';
import { TEMP_ROOTS, WINDOWS_TEMP } from './shellRemovalScope.js';

export interface ICommandPathScope {
	/** Абсолютные корни, внутри которых путь свой: папки проекта, корень прогона */
	readonly roots: readonly string[];
	/** Сравнение без учёта регистра — macOS и Windows */
	readonly caseInsensitive: boolean;
}

export interface ICommandOutsidePath {
	/** Путь, как он записан в команде */
	readonly path: string;
	/** Корень диска, тома или домашней папки: очистка такого пути — потеря всего */
	readonly critical: boolean;
}

/** Каталоги, которые не являются данными: ссылка на них не выводит команду из проекта */
const NON_PATHS: ReadonlySet<string> = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

/** Системные каталоги, потеря самого каталога необратима, а вложенные пути — уже нет */
const SYSTEM_ROOTS = ['System', 'usr', 'etc', 'bin', 'var', 'Library', 'private'] as const;

/**
 * Найти пути вне области, в порядке появления в команде
 *
 * `roots` — то, что считается своим; временные каталоги свои по определению
 * `caseInsensitive` учитывает, что macOS сравнивает имена без регистра
 */
export function commandPathsOutsideScope(command: string, scope: ICommandPathScope): ICommandOutsidePath[] {
	const outside: ICommandOutsidePath[] = [];
	const seen = new Set<string>();
	for (const segment of splitShellSegments(slashedWindowsPaths(command))) {
		for (const arg of segment.args) {
			const value = pathValueOf(arg);
			if (value === undefined) {
				continue;
			}
			const found = classify(value, scope);
			if (found === undefined || seen.has(found.key)) {
				continue;
			}
			seen.add(found.key);
			outside.push({ path: value, critical: found.critical });
		}
	}
	return outside;
}

/**
 * Текст для модели и диалога: какие пути выходят за проект и чем опасны корневые
 *
 * Пустой список сюда не передают: без путей сообщения нет
 */
export function describeOutsidePaths(paths: readonly ICommandOutsidePath[]): string {
	const listed = paths.map(item => item.critical
		? `«${item.path}» — корень диска или домашней папки`
		: `«${item.path}»`);
	return `Пути вне папок проекта: ${listed.join('; ')}.`;
}

/** `C:\Users` и `\\server\share` — разделители Windows, а разбор строки считает `\` экранированием */
const WINDOWS_PATH_TOKEN = /(^|[\s=])((?:[A-Za-z]:|\\\\[^\\\s]+)[^\s]*)/g;

function slashedWindowsPaths(command: string): string {
	return command.replace(WINDOWS_PATH_TOKEN, (match: string, lead: string, token: string) => {
		// Корень диска `D:\` разбор и так сохраняет: экранировать в нём нечего
		return /^[A-Za-z]:\\$/.test(token) ? match : `${lead}${token.replace(/\\/g, '/')}`;
	});
}

/** Значение аргумента, если оно похоже на путь: сама опция путём не считается */
function pathValueOf(arg: string): string | undefined {
	if (arg.includes('://')) {
		return undefined;
	}
	if (arg.startsWith('--')) {
		const equals = arg.indexOf('=');
		return equals < 0 ? undefined : asPath(arg.slice(equals + 1));
	}
	if (arg.startsWith('-')) {
		// `-o/path`, `-I/usr/include`: значение приклеено к короткой опции
		const starts = ['/', '~', '$'].map(marker => arg.indexOf(marker, 1)).filter(index => index > 0);
		return starts.length === 0 ? undefined : asPath(arg.slice(Math.min(...starts)));
	}
	const equals = arg.indexOf('=');
	// `NAME=/path`: присвоение переменной перед программой или значение без пробела
	return asPath(equals < 0 ? arg : arg.slice(equals + 1));
}

/** Путь-кандидат без разбора его вида; URL и служебные устройства отбрасываются */
function asPath(value: string): string | undefined {
	if (!value || value.includes('://') || NON_PATHS.has(value)) {
		return undefined;
	}
	return isPathCandidate(value) ? value : undefined;
}

/** Абсолютный путь, домашний каталог или выход вверх — остальное аргумент, а не путь */
function isPathCandidate(value: string): boolean {
	const slashed = slashedPath(value);
	return slashed.startsWith('/')
		|| /^[A-Za-z]:\//.test(slashed)
		|| /^\/\/[^/]+\/[^/]+/.test(slashed)
		|| slashed === '..' || slashed.startsWith('../')
		|| isHomePath(slashed);
}

/** `~`, `$HOME` и их продолжения: без раскрытия они всегда вне проекта */
function isHomePath(value: string): boolean {
	return value === '~' || value.startsWith('~/')
		|| value === '$HOME' || value.startsWith('$HOME/')
		|| value === '${HOME}' || value.startsWith('${HOME}/');
}

interface IClassifiedPath {
	/** Ключ для устранения дублей: один путь, записанный по-разному, остаётся одним */
	readonly key: string;
	readonly critical: boolean;
}

/** Решение по одному пути: свой, внешний некритичный или критичный */
function classify(value: string, scope: ICommandPathScope): IClassifiedPath | undefined {
	const slashed = slashedPath(value);
	if (isHomePath(slashed)) {
		return { key: `home:${fold(slashed, scope.caseInsensitive)}`, critical: true };
	}
	if (slashed === '..' || slashed.startsWith('../')) {
		// Относительный путь читается от неизвестного каталога строки, поэтому он всегда внешний
		return { key: `up:${fold(normalizePath(slashed), scope.caseInsensitive)}`, critical: false };
	}
	const normalized = normalizePath(slashed);
	if (isInsideAny(normalized, scope.roots, scope.caseInsensitive) || isTemp(normalized, scope.caseInsensitive)) {
		return undefined;
	}
	return { key: `path:${fold(normalized, scope.caseInsensitive)}`, critical: isCritical(normalized, scope.caseInsensitive) };
}

/** Путь лежит в одном из корней: сам корень и всё под ним */
function isInsideAny(path: string, roots: readonly string[], caseInsensitive: boolean): boolean {
	const folded = fold(path, caseInsensitive);
	return roots.some(root => {
		const foldedRoot = fold(normalizePath(slashedPath(root)), caseInsensitive);
		return foldedRoot === '/' ? folded.startsWith('/') : folded === foldedRoot || folded.startsWith(`${foldedRoot}/`);
	});
}

/** Временный каталог — не потеря: там лежат промежуточные файлы, а не работа пользователя */
function isTemp(path: string, caseInsensitive: boolean): boolean {
	const folded = fold(path, caseInsensitive);
	if (TEMP_ROOTS.some(root => folded === fold(root, caseInsensitive) || folded.startsWith(`${fold(root, caseInsensitive)}/`))) {
		return true;
	}
	return WINDOWS_TEMP.test(`${folded}/`);
}

/** Корень диска, тома, домашней папки или системного каталога */
function isCritical(path: string, caseInsensitive: boolean): boolean {
	const folded = fold(path, caseInsensitive);
	const name = (canonical: string) => fold(canonical, caseInsensitive);
	if (folded === '/') {
		return true;
	}
	if (/^[a-z]:\/$/.test(folded)) {
		return true;
	}
	// Корень общего каталога Windows: `//server/share` без вложенных папок
	if (/^\/\/[^/]+\/[^/]+$/.test(folded)) {
		return true;
	}
	const parts = folded.split('/').filter(part => part.length > 0);
	if (parts[0] === name('Volumes') && parts.length <= 2) {
		return true;
	}
	if (parts[0] === name('Users') && parts.length <= 2) {
		return true;
	}
	if (parts[0] === name('home') && parts.length <= 2) {
		return true;
	}
	if (parts[0] === name('mnt') && parts.length <= 2) {
		return true;
	}
	if (parts[0] === name('media') && parts.length <= 3) {
		return true;
	}
	if (parts.length === 1 && (parts[0] === name('root') || SYSTEM_ROOTS.some(root => parts[0] === name(root)))) {
		return true;
	}
	return false;
}

/**
 * Приведение к одному виду: прямые слэши, без `.`, `..` и повторных слэшей
 *
 * Ведущие `//` сохраняются: это не повтор слэша, а имя общего каталога Windows
 */
function normalizePath(path: string): string {
	const slashed = slashedPath(path);
	const drive = /^([A-Za-z]):(?=\/|$)/.exec(slashed);
	const unc = !drive && slashed.startsWith('//');
	const prefix = drive ? `${drive[1].toLowerCase()}:` : unc ? '//' : slashed.startsWith('/') ? '/' : '';
	const parts: string[] = [];
	for (const part of slashed.slice(prefix.length).split('/')) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			// Выше корня абсолютного пути выйти нельзя; у относительного `..` остаётся как есть
			if (parts.length > 0 && parts[parts.length - 1] !== '..') {
				parts.pop();
			} else if (prefix === '') {
				parts.push(part);
			}
		} else {
			parts.push(part);
		}
	}
	if (prefix === '//') {
		return `//${parts.join('/')}`;
	}
	if (prefix.endsWith(':')) {
		return `${prefix}/${parts.join('/')}`;
	}
	return `/${parts.join('/')}`;
}

function slashedPath(path: string): string {
	return path.replace(/\\/g, '/');
}

function fold(path: string, caseInsensitive: boolean): string {
	return caseInsensitive ? path.toLowerCase() : path;
}
