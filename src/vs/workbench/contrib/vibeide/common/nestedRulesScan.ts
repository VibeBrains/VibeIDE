/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Поиск вложенных `AGENTS.md` в монорепозитории — чистые правила обхода.
 *
 * Стандарт agents.md: «Agents automatically read the nearest file in the directory tree, so the
 * closest one takes precedence and every subproject can ship tailored instructions». То есть у
 * пакета монорепозитория свой файл правил, и корневой его не заменяет.
 *
 * Обход ограничен глубиной и списком папок, которые пропускаются: дерево проекта содержит
 * `node_modules` и каталоги сборки, где счёт файлов идёт на сотни тысяч, а правил проекта нет ни
 * одного. Без пропуска обход правил стал бы обходом всего диска при каждом перечитывании.
 */

/** Имя файла правил, которое ищется во вложенных папках. Корневой читается отдельно, как обычно. */
export const NESTED_RULE_FILE_NAME = 'AGENTS.md';

/**
 * Глубина вложенности по умолчанию.
 *
 * Пакет монорепозитория лежит на втором уровне (`packages/<имя>/AGENTS.md`), третий даёт запас на
 * `apps/web/frontend`. Глубже — это уже не «подпроект», а случайный файл с тем же именем.
 */
export const DEFAULT_NESTED_RULE_DEPTH = 3;

/**
 * Папки, в которые обход не заходит.
 *
 * Список закрытый и намеренно не настраиваемый: это не вкус, а места, где правил проекта не бывает,
 * зато бывают десятки тысяч файлов. Настройке подлежит глубина, а не это.
 */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
	'node_modules', '.git', '.hg', '.svn', '.vibe', '.vscode', '.idea',
	'dist', 'out', 'build', 'target', 'vendor', 'coverage', '.next', '.nuxt', '.turbo',
	'.venv', 'venv', '__pycache__', '.gradle', '.cache', 'tmp', 'temp',
]);

/** True — в эту папку обход не заходит. Скрытые папки пропускаются целиком: там служебное. */
export function isSkippedRuleDir(name: string): boolean {
	if (!name) { return true; }
	if (SKIPPED_DIRS.has(name)) { return true; }
	// `.github` и подобные — служебные каталоги инструментов, а не подпроекты. Корневой `AGENTS.md`
	// это не затрагивает: он читается отдельно и в обход не попадает.
	return name.startsWith('.');
}
