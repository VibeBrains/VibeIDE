/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Перенос путей прогона в его рабочее дерево — чистая часть изоляции субагента.
 *
 * Дерево агента лежит ВНУТРИ рабочей области (`.vibe-worktrees/<ветка>`), поэтому порядок проверок
 * здесь не украшение: путь, уже попавший в дерево, обязан проверяться раньше, чем путь под корнем
 * рабочей области, — иначе перенос сработал бы второй раз и загнал файл в дерево внутри дерева.
 *
 * Путь вне рабочей области не переносится вовсе: наружу ведут заранее разрешённые пользователем
 * папки, и утащить их под дерево агента значило бы писать не туда, куда он просил.
 */

/** Разделители к одному виду и без хвостовой косой черты — сравнивать можно только так. */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isUnder(root: string, path: string, ignoreCase: boolean): boolean {
	if (!root) {
		return false;
	}
	const a = ignoreCase ? root.toLowerCase() : root;
	const b = ignoreCase ? path.toLowerCase() : path;
	return b === a || b.startsWith(`${a}/`);
}

/**
 * Путь `target` в системе координат дерева прогона.
 *
 * @param workspaceRoot Корень открытой папки
 * @param worktreeRoot Корень дерева прогона
 * @param target Абсолютный путь, каким его выдал разбор параметров инструмента
 * @param ignoreCase Регистр имён не значим (Windows, macOS). На Linux — значим, и совпадение
 * корня «с точностью до регистра» там означало бы другой каталог, а не тот же самый
 */
export function rebaseIntoWorktree(workspaceRoot: string, worktreeRoot: string, target: string, ignoreCase: boolean = false): string {
	const root = normalizePath(workspaceRoot);
	const tree = normalizePath(worktreeRoot);
	const path = normalizePath(target);
	if (!tree || !root) {
		return target;
	}
	if (isUnder(tree, path, ignoreCase)) {
		return target;
	}
	if (!isUnder(root, path, ignoreCase)) {
		return target;
	}
	const tail = path.slice(root.length);
	return `${tree}${tail}`;
}

/**
 * Путь относительно корня — тем же правилом, каким его считает граница записи шага.
 *
 * Вне корня путь возвращается как есть: назвать его «относительным» значило бы соврать о том, где
 * он лежит, а границы записи такое имя приняли бы за свой путь.
 */
export function relativeToRoot(root: string, target: string, ignoreCase: boolean = false): string {
	const base = normalizePath(root);
	const path = normalizePath(target);
	if (!base || !isUnder(base, path, ignoreCase)) {
		return path;
	}
	return path.slice(base.length).replace(/^\//, '');
}
