/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';

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

/**
 * До какой глубины искать пути в параметрах вызова.
 *
 * Параметры инструментов плоские или почти плоские, а неограниченный обход чужого объекта — способ повесить
 * ход на циклической ссылке.
 */
export const MAX_PARAM_REBASE_DEPTH = 4;

/**
 * Параметры вызова инструмента в системе координат дерева прогона.
 *
 * Правило структурное — «значение типа `URI` под корнем открытой папки», а не список инструментов:
 * список пришлось бы дополнять при каждом новом инструменте, и забытая строка тихо вернула бы роль в общую
 * папку. Читающие вызовы переносятся наравне с пишущими: роль, которая правит своё дерево, а читает общую
 * папку, видит файл, который она уже не правит.
 *
 * Обход рекурсивный: путь, завёрнутый во вложенный объект, — тот же путь, и оставь его на месте, роль
 * записала бы в общую папку через один лишний уровень вложенности.
 */
export function rebaseParamsIntoWorktree(params: unknown, workspaceRoot: string, worktreeRoot: string, ignoreCase: boolean = false): unknown {
	if (!worktreeRoot || !workspaceRoot || typeof params !== 'object' || params === null) {
		return params;
	}
	const move = (value: unknown, depth: number): unknown => {
		if (value instanceof URI) {
			if (value.scheme !== Schemas.file) { return value; }
			const target = normalizePath(value.fsPath);
			const moved = rebaseIntoWorktree(workspaceRoot, worktreeRoot, target, ignoreCase);
			return moved === target ? value : URI.file(moved);
		}
		if (depth >= MAX_PARAM_REBASE_DEPTH) { return value; }
		if (Array.isArray(value)) { return value.map(item => move(item, depth + 1)); }
		// Только простые объекты: классы со своим поведением копирование распылённым объектом сломало бы.
		if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
			const nested: Record<string, unknown> = { ...(value as Record<string, unknown>) };
			for (const key of Object.keys(nested)) {
				nested[key] = move(nested[key], depth + 1);
			}
			return nested;
		}
		return value;
	};
	const out: Record<string, unknown> = { ...(params as Record<string, unknown>) };
	for (const key of Object.keys(out)) {
		out[key] = move(out[key], 0);
	}
	// Команда оболочки не несёт `URI` — только строку папки, а по умолчанию это открытая папка.
	// Оставить умолчание значило бы выполнить сборку и тесты роли мимо её дерева.
	if ('command' in out && 'cwd' in out) {
		const cwd = out['cwd'];
		out['cwd'] = typeof cwd === 'string' && cwd.trim()
			? (isAbsolutePath(cwd)
				? rebaseIntoWorktree(workspaceRoot, worktreeRoot, normalizePath(cwd), ignoreCase)
				: `${normalizePath(worktreeRoot)}/${normalizePath(cwd)}`)
			: normalizePath(worktreeRoot);
	}
	return out;
}

/** Абсолютный путь — POSIX-корень или диск Windows; относительный считается от дерева прогона. */
function isAbsolutePath(path: string): boolean {
	return /^([a-zA-Z]:[\\/]|\/)/.test(path);
}
