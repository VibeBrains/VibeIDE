/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { match } from '../../../../base/common/glob.js';
import { WORKTREE_DIR } from './worktreeNaming.js';

/**
 * Что из игнорируемого git попадает в рабочее дерево роли — чистая часть.
 *
 * `git worktree add` выкладывает только отслеживаемые файлы
 * Без `.env` и `node_modules` проверка проекта в дереве падает не на работе роли, а на пустом окружении
 *
 * Здесь — настройки, argv и выбор путей; копирование, ссылки и запись на диск живут в главном процессе
 */

/** Как приносить папки зависимостей: копией при записи, ссылкой на папку проекта или никак. */
export type WorktreeLinkMode = 'clone' | 'link' | 'none';

export const WORKTREE_INCLUDE_SETTING = {
	files: 'vibeide.subagent.worktreeInclude',
	folders: 'vibeide.subagent.worktreeLinkFolders',
	mode: 'vibeide.subagent.worktreeLinkMode',
} as const;

/** Файлы окружения: без них проект в дереве не запускается, а в git их нет по определению. */
export const DEFAULT_WORKTREE_INCLUDE_FILES: readonly string[] = ['.env', '.env.*', '**/.env.local'];

/**
 * Только зависимости
 * Сборочные папки (`out/`) роль собирает сама: чужая сборка в дереве выдала бы старый код за проверенный
 */
export const DEFAULT_WORKTREE_LINK_FOLDERS: readonly string[] = ['node_modules'];

/**
 * Режим по умолчанию зависит от системы
 * На APFS копия при записи мгновенна и не занимает места, и роль получает свою папку
 * На других системах копия — это полная копия, поэтому там дешевле ссылка
 */
export function defaultWorktreeLinkMode(isMacintosh: boolean): WorktreeLinkMode {
	return isMacintosh ? 'clone' : 'link';
}

/** Что настроено для дерева роли — и что уходит в главный процесс при его создании. */
export interface IWorktreeIncludeOptions {
	/** Шаблоны glob от корня репозитория: подходящие игнорируемые файлы копируются. */
	readonly files: readonly string[];
	/** Имена или шаблоны путей игнорируемых папок, которые приносятся режимом `mode`. */
	readonly folders: readonly string[];
	readonly mode: WorktreeLinkMode;
}

/** Режим из настройки; чужое значение — умолчание системы, а не молчаливое «никак». */
export function readWorktreeLinkMode(raw: unknown, isMacintosh: boolean): WorktreeLinkMode {
	return raw === 'clone' || raw === 'link' || raw === 'none' ? raw : defaultWorktreeLinkMode(isMacintosh);
}

/** Список шаблонов из настройки: только непустые строки; не список — умолчание. */
export function readPatternList(raw: unknown, fallback: readonly string[]): string[] {
	if (!Array.isArray(raw)) {
		return [...fallback];
	}
	return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim());
}

/** Argv (без ведущего `git`). */
export const WORKTREE_INCLUDE_ARGV = {
	/**
	 * Игнорируемые записи с целиком игнорируемыми папками одной строкой `папка/`
	 * Внутрь такой папки git не спускается, поэтому `node_modules` перечисляется мгновенно
	 */
	ignoredEntries: ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'],
	/**
	 * Игнорируемые файлы под шаблонами включения
	 * Шаблоны отдаются git как pathspec, чтобы он не перечислял сотни тысяч файлов зависимостей
	 * Уже выбранные папки и сами деревья агентов исключены: копии зависимостей в них огромны
	 */
	ignoredFiles: (patterns: readonly string[], skipFolders: readonly string[]) => [
		'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--',
		...patterns.map(pattern => `:(glob)${pattern}`),
		...[WORKTREE_DIR, ...skipFolders].map(folder => `:(exclude,literal)${folder}`),
	],
	/** Отслеживаемое в новом дереве: принести поверх него игнорируемое значило бы затереть работу. */
	trackedFiles: ['ls-files', '-z'],
	/**
	 * Снять ссылки с индекса после `add -A`
	 * Исключающий pathspec тут не годится: на игнорируемый путь `git add` отвечает ошибкой
	 */
	unstage: (paths: readonly string[]) => ['--literal-pathspecs', 'rm', '--cached', '--ignore-unmatch', '-q', '--', ...paths],
	/** Служебный каталог дерева в `.git/worktrees/<имя>` — там лежит список наших ссылок. */
	worktreeGitDir: ['rev-parse', '--absolute-git-dir'],
	/** `info/exclude` общего каталога git — верно и из дерева, и когда `.git` — файл. */
	excludeFile: ['rev-parse', '--git-path', 'info/exclude'],
} as const;

/** Где в служебном каталоге дерева лежит список ссылок: он переживает перезапуск IDE и уходит вместе с деревом. */
export const LINKED_PATHS_FILE = 'vibe-linked-paths.json';

/** Вывод `git … -z` по записям. */
export function parseNulList(stdout: string): string[] {
	return stdout.split('\0').filter(entry => entry.length > 0);
}

function normalizeRelative(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Строка `info/exclude` для папки дерева: со слэшем, чтобы задевать только каталог. */
export function folderExcludeLine(relativePath: string): string {
	return `/${normalizeRelative(relativePath)}/`;
}

/**
 * Строка `info/exclude` для ссылки — без слэша на конце
 * Для git ссылка — файл, и шаблон `node_modules/` из `.gitignore` её не задевает, а `add -A` её закоммитил бы
 */
export function linkExcludeLine(relativePath: string): string {
	return `/${normalizeRelative(relativePath)}`;
}

function isUnderAgentTrees(path: string): boolean {
	return path === WORKTREE_DIR || path.startsWith(`${WORKTREE_DIR}/`);
}

function isUnderAny(path: string, folders: readonly string[]): boolean {
	return folders.some(folder => path === folder || path.startsWith(`${folder}/`));
}

/** Шаблон без `/` — имя папки на любой глубине, как в `.gitignore`; со `/` — путь от корня. */
function folderMatches(path: string, pattern: string): boolean {
	if (!pattern.includes('/')) {
		const name = path.slice(path.lastIndexOf('/') + 1);
		return match(pattern, name);
	}
	return match(normalizeRelative(pattern), path);
}

/**
 * Занят ли путь отслеживаемым в дереве
 * Сам путь, файл под ним (для папки) или файл на месте одной из его папок
 */
function collidesWithTracked(path: string, tracked: ReadonlySet<string>, trackedDirs: ReadonlySet<string>): boolean {
	if (tracked.has(path) || trackedDirs.has(path)) {
		return true;
	}
	for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
		if (tracked.has(path.slice(0, index))) {
			return true;
		}
	}
	return false;
}

function trackedIndex(tracked: readonly string[]): { readonly files: ReadonlySet<string>; readonly dirs: ReadonlySet<string> } {
	const files = new Set(tracked.map(normalizeRelative));
	const dirs = new Set<string>();
	for (const file of files) {
		for (let index = file.indexOf('/'); index !== -1; index = file.indexOf('/', index + 1)) {
			dirs.add(file.slice(0, index));
		}
	}
	return { files, dirs };
}

/**
 * Какие игнорируемые папки принести в дерево
 *
 * Берутся только целиком игнорируемые папки (`папка/` в выводе `--directory`): в папке с отслеживаемыми
 * файлами ссылка или копия легли бы поверх работы роли
 * Вложенная папка уходит, если принесена объемлющая: она приезжает вместе с ней
 *
 * @param ignoredEntries Вывод `ignoredEntries`
 * @param patterns Имена или шаблоны путей из настройки
 * @param tracked Отслеживаемое в новом дереве
 */
export function selectLinkFolders(ignoredEntries: readonly string[], patterns: readonly string[], tracked: readonly string[]): string[] {
	if (patterns.length === 0) {
		return [];
	}
	const index = trackedIndex(tracked);
	const picked = ignoredEntries
		.filter(entry => entry.endsWith('/'))
		.map(normalizeRelative)
		.filter(path => path.length > 0 && !isUnderAgentTrees(path))
		.filter(path => patterns.some(pattern => folderMatches(path, pattern)))
		.filter(path => !collidesWithTracked(path, index.files, index.dirs));
	const unique = [...new Set(picked)].sort();
	return unique.filter(path => !unique.some(other => other !== path && path.startsWith(`${other}/`)));
}

/**
 * Какие игнорируемые файлы скопировать в дерево
 *
 * Git отбирает по шаблонам грубо (pathspec), окончательное слово — за glob редактора: у шаблонов одна семантика
 * с `files.exclude`, а не две
 *
 * @param ignoredFiles Вывод `ignoredFiles`
 * @param patterns Шаблоны glob от корня репозитория
 * @param tracked Отслеживаемое в новом дереве
 * @param broughtFolders Уже принесённые папки — их файлы приезжают вместе с ними
 */
export function selectIncludeFiles(ignoredFiles: readonly string[], patterns: readonly string[], tracked: readonly string[], broughtFolders: readonly string[]): string[] {
	if (patterns.length === 0) {
		return [];
	}
	const index = trackedIndex(tracked);
	const picked = ignoredFiles
		.map(normalizeRelative)
		.filter(path => path.length > 0 && !isUnderAgentTrees(path) && !isUnderAny(path, broughtFolders))
		.filter(path => patterns.some(pattern => match(normalizeRelative(pattern), path)))
		.filter(path => !collidesWithTracked(path, index.files, index.dirs));
	return [...new Set(picked)].sort();
}
