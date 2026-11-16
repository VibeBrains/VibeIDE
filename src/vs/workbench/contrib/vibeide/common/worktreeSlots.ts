/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Слот ресурсов рабочего дерева роли — чистая часть
 *
 * Несколько деревьев параллельно делят порты и имя стенда docker compose, и стенды гасят друг
 * друга. Номер слота превращает это в договор: из него считаются порты и имя проекта, поэтому
 * одна и та же пара «номер и настройки» всегда даёт одни и те же значения
 */

/** Файл слота в служебном каталоге дерева `.git/worktrees/<имя>/` */
export const WORKTREE_SLOT_FILE = 'vibe-slot';

/** Файл слота в корне дерева: его читают команды и человек */
export const WORKTREE_SLOT_ENV_FILE = '.vibe-slot.env';

export const WORKTREE_SLOT_SETTING = {
	enabled: 'vibeide.subagent.worktreeSlots',
	ports: 'vibeide.subagent.worktreeSlotPorts',
	max: 'vibeide.subagent.worktreeSlotMax',
} as const;

/** Порты по умолчанию: без настройки дерево получает свой `PORT` */
export const DEFAULT_WORKTREE_SLOT_PORTS: Readonly<Record<string, number>> = { PORT: 3000 };

export const DEFAULT_WORKTREE_SLOT_MAX = 9;

export interface IWorktreeSlotOptions {
	readonly ports: Readonly<Record<string, number>>;
	readonly max: number;
}

/** Наименьший свободный номер 1..max, иначе undefined */
export function pickWorktreeSlot(taken: readonly number[], max: number): number | undefined {
	const busy = new Set(taken.filter(slot => Number.isInteger(slot) && slot > 0));
	for (let slot = 1; slot <= max; slot++) {
		if (!busy.has(slot)) {
			return slot;
		}
	}
	return undefined;
}

/** Имя проекта docker compose: только [a-z0-9_-], прочее заменяется на `-` */
function composeSafeName(repoName: string): string {
	return repoName.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

/** Переменные слота: VIBE_SLOT, каждый порт = база + номер, COMPOSE_PROJECT_NAME = <имя репозитория>-slot<N> */
export function worktreeSlotEnv(slot: number, repoName: string, ports: Readonly<Record<string, number>>): Record<string, string> {
	const env: Record<string, string> = { VIBE_SLOT: String(slot) };
	for (const [name, base] of Object.entries(ports)) {
		const port = base + slot;
		// Порт за пределом диапазона не адрес, а ошибка: переменную не пишем, остальные остаются
		if (port > 65535) {
			continue;
		}
		env[name] = String(port);
	}
	env.COMPOSE_PROJECT_NAME = `${composeSafeName(repoName)}-slot${slot}`;
	return env;
}

/** Текст `.vibe-slot.env`: строка-комментарий о назначении, затем KEY=value построчно */
export function formatSlotEnvFile(env: Readonly<Record<string, string>>): string {
	return [
		'# Слот ресурсов дерева роли: порты и имя стенда docker compose; файл создан автоматически',
		...Object.entries(env).map(([key, value]) => `${key}=${value}`),
		'',
	].join('\n');
}

/** Разбор содержимого файла vibe-slot (число) — мусор → undefined */
export function parseSlotFile(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) {
		return undefined;
	}
	const slot = Number(trimmed);
	return Number.isInteger(slot) && slot > 0 ? slot : undefined;
}

/** Разбор настроек: неверная форма значения откатывается к умолчанию, а не ломает запуск */
export function readSlotOptions(ports: unknown, max: unknown): IWorktreeSlotOptions {
	let parsedPorts: Readonly<Record<string, number>> = DEFAULT_WORKTREE_SLOT_PORTS;
	if (typeof ports === 'object' && ports !== null && !Array.isArray(ports)) {
		const entries = Object.entries(ports as Record<string, unknown>);
		if (entries.every(([name, base]) => /^[A-Z_][A-Z0-9_]*$/.test(name) && typeof base === 'number' && Number.isInteger(base) && base >= 1 && base <= 65535)) {
			parsedPorts = Object.fromEntries(entries as Array<[string, number]>);
		}
	}
	const parsedMax = typeof max === 'number' && Number.isInteger(max) && max >= 1 && max <= 99 ? max : DEFAULT_WORKTREE_SLOT_MAX;
	return { ports: parsedPorts, max: parsedMax };
}

/** Переменные из текста `.vibe-slot.env`: строки KEY=value, комментарии и мусор пропускаются */
export function parseSlotEnvFile(text: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const line of text.split(/\r?\n/)) {
		const match = /^(?<name>[A-Z_][A-Z0-9_]*)=(?<value>[^\r\n]*)$/.exec(line.trim());
		if (match?.groups) {
			env[match.groups.name] = match.groups.value;
		}
	}
	return env;
}

/**
 * Корень дерева агента, внутри которого лежит путь, — `…/<WORKTREE_DIR>/<имя>`, иначе undefined
 * По папке запуска команда находит слот своего дерева, не протаскивая его через параметры инструмента
 */
export function agentWorktreeRootOf(path: string, worktreeDir: string): string | undefined {
	const slashed = path.replace(/\\/g, '/');
	const marker = `/${worktreeDir}/`;
	const at = slashed.indexOf(marker);
	if (at < 0) {
		return undefined;
	}
	const nameEnd = slashed.indexOf('/', at + marker.length);
	const end = nameEnd < 0 ? slashed.length : nameEnd;
	return end > at + marker.length ? path.slice(0, end) : undefined;
}
