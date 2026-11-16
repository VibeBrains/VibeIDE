/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { WORKTREE_SLOT_FILE } from './worktreeSlots.js';

/**
 * Имена и пути рабочих деревьев агента, плюс разбор того, что о них знает git.
 *
 * Листинг дополняется строкой `vibe-slot <номер>`: git о слотах не знает, их читает main-сервис
 *
 * Чистая часть изоляции: имя ветки и путь считаются без обращения к диску, поэтому их можно
 * проверить тестом, а не живым репозиторием.
 */

/** Куда складываются деревья агентов: внутри репозитория, но вне индекса (см. `info/exclude`). */
export const WORKTREE_DIR = '.vibe-worktrees';

/** По этому префиксу дерево агента и строится, и узнаётся обратно в выводе git — источник один. */
export const AGENT_BRANCH_PREFIX = 'vibe-agent-';

/**
 * Имя ветки для прогона.
 *
 * Git отвергает не всякое имя: пробелы, `~`, `^`, `:`, `?`, `*`, `[`, две точки подряд и конец на
 * `.lock` — всё это ошибка при создании. Идентификатор сессии приходит откуда угодно, поэтому он
 * приводится к безопасному виду здесь, а не выясняется по ошибке git в середине работы.
 */
export function worktreeBranchName(sessionId: string): string {
	const safe = sessionId
		.toLowerCase()
		// Буквы любого языка остаются: git и файловые системы принимают UTF-8, а выброшенная
		// кириллица превратила бы «Правка: файл 2» в имя из одной цифры.
		.replace(/[^\p{L}\p{N}._-]+/gu, '-')
		.replace(/\.{2,}/g, '.')
		.replace(/^[-.]+|[-.]+$/g, '')
		.replace(/\.lock$/, 'lock')
		// Обрезка намеренная: имя ветки видно в каждом `git branch`, а идентификатор прогона длинный.
		.slice(0, 40);
	return `${AGENT_BRANCH_PREFIX}${safe || 'session'}`;
}

/** Путь дерева относительно корня репозитория. */
export function worktreeRelativePath(branch: string): string {
	return `${WORKTREE_DIR}/${branch}`;
}

/** Одно дерево, как его перечисляет `git worktree list --porcelain`. */
export interface GitWorktreeEntry {
	readonly path: string;
	readonly branch?: string;
	/** Дерево без ветки — отсоединённая голова; сливать там нечего. */
	readonly detached: boolean;
	/** Слот ресурсов, если листинг его знает: строка `vibe-slot <номер>` в записи дерева. */
	readonly slot?: number;
}

/**
 * Разобрать вывод `git worktree list --porcelain`.
 *
 * Формат — записи, разделённые пустой строкой: `worktree <путь>`, затем `HEAD`, затем либо
 * `branch refs/heads/<имя>`, либо `detached`.
 */
export function parseWorktreeList(porcelain: string): GitWorktreeEntry[] {
	const entries: GitWorktreeEntry[] = [];
	let path: string | undefined;
	let branch: string | undefined;
	let detached = false;
	let slot: number | undefined;
	const flush = () => {
		if (path) {
			entries.push({ path, ...(branch ? { branch } : {}), detached, ...(slot !== undefined ? { slot } : {}) });
		}
		path = undefined;
		branch = undefined;
		detached = false;
		slot = undefined;
	};
	for (const rawLine of porcelain.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			flush();
			continue;
		}
		if (line.startsWith('worktree ')) {
			flush();
			path = line.slice('worktree '.length);
		} else if (line.startsWith('branch ')) {
			branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
		} else if (line === 'detached') {
			detached = true;
		} else if (line.startsWith(`${WORKTREE_SLOT_FILE} `)) {
			const parsed = Number(line.slice(WORKTREE_SLOT_FILE.length + 1));
			slot = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
		}
	}
	flush();
	return entries;
}
