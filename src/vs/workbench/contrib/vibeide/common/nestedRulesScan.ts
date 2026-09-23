/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Поиск вложенных `AGENTS.md` в монорепозитории — правила обхода и сам обход.
 *
 * Стандарт agents.md: «Agents automatically read the nearest file in the directory tree, so the
 * closest one takes precedence and every subproject can ship tailored instructions». То есть у
 * пакета монорепозитория свой файл правил, и корневой его не заменяет.
 *
 * Обход ограничен глубиной и списком папок, которые пропускаются: дерево проекта содержит
 * `node_modules` и каталоги сборки, где счёт файлов идёт на сотни тысяч, а правил проекта нет ни
 * одного. Без пропуска обход правил стал бы обходом всего диска при каждом перечитывании.
 */

import { URI } from '../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';

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

/**
 * Nested `AGENTS.md` files of subprojects — the root one excluded, it is read separately.
 *
 * Every folder is expanded by its own `resolve` call, because `resolve` without `resolveTo` expands
 * exactly one level: the child folders come back with no `children`. So the file is looked for among
 * the children of the folder just expanded — looking among grandchildren finds nothing on a real file
 * service. The walk goes through `IFileService` rather than the disk so that a test can run it on an
 * in-memory file system, i.e. on the real `resolve` rather than a stub with a pre-expanded tree.
 *
 * Depth counts folders from the root: `src/AGENTS.md` is level one, `packages/<name>/AGENTS.md` level
 * two; zero turns the search off. Children are walked by name so that the model sees the rules in the
 * same order on every run — a different order would change the prompt cache key for no reason.
 */
export async function collectNestedAgentsUris(fileService: IFileService, root: URI, maxDepth: number): Promise<URI[]> {
	return walkNestedAgents(fileService, root, 0, maxDepth);
}

async function walkNestedAgents(fileService: IFileService, dir: URI, depth: number, maxDepth: number): Promise<URI[]> {
	let stat: IFileStat;
	try {
		stat = await fileService.resolve(dir);
	} catch {
		return [];
	}
	if (!stat.isDirectory || !stat.children) { return []; }
	const children = [...stat.children].sort((a, b) => a.name.localeCompare(b.name));
	const found: URI[] = [];
	if (depth > 0) {
		const rules = children.find(child => !child.isDirectory && child.name === NESTED_RULE_FILE_NAME);
		if (rules) { found.push(rules.resource); }
	}
	if (depth >= maxDepth) { return found; }
	for (const child of children) {
		if (child.isDirectory && !isSkippedRuleDir(child.name)) {
			found.push(...await walkNestedAgents(fileService, child.resource, depth + 1, maxDepth));
		}
	}
	return found;
}
