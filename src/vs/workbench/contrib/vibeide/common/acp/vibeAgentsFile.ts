/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * `.vibe/agents.json` — внешние агенты проекта, говорящие на ACP (JSONC; комментарии разрешены).
 *
 * Реестр отвечает на вопрос «кого можно позвать в этой рабочей папке»: имя, чем запускать, в
 * какой папке. Кладётся в репозиторий — набор агентов у команды общий, как дев-стек.
 *
 * Слой чистый: типы (они же каноническая схема), разбор, структурная проверка. Ни процессов, ни
 * файловой системы — поэтому формат проверяется из `test/common/`, а запускает агентов хост.
 *
 * ОТСУТСТВИЕ ФАЙЛА = СЕГОДНЯШНЕЕ ПОВЕДЕНИЕ. Без `.vibe/agents.json` внешних агентов просто нет,
 * и ничего из описанного здесь не запускается.
 */

import { safeParseConfigJson } from '../vibeConfigJsonParser.js';

/** Запись реестра: один внешний агент. */
export interface VibeAgentEntry {
	/** Уникальный ключ в пределах файла. По нему агента зовут из чата и находят в логах. */
	readonly id: string;
	/** Имя для человека. По умолчанию — `id`. */
	readonly name?: string;
	/** Default true. `false` оставляет запись документированной, но вне списка. */
	readonly active?: boolean;

	/** Исполняемый файл. Запускается напрямую, без оболочки: строка «команда с аргументами» не пройдёт. */
	readonly command: string;
	/** Аргументы по одному элементу на аргумент. */
	readonly args?: readonly string[];
	/** Переменные окружения поверх унаследованных. */
	readonly env?: Readonly<Record<string, string>>;
	/** Рабочая папка агента относительно корня проекта. По умолчанию — корень. */
	readonly dir?: string;
}

export interface VibeAgentsFile {
	readonly version: number;
	readonly agents: readonly VibeAgentEntry[];
}

/** Что нашлось в файле и на что жаловаться. Битая запись пропускается, а не роняет реестр. */
export interface VibeAgentsParseResult {
	readonly agents: readonly VibeAgentEntry[];
	readonly problems: readonly string[];
}

const EMPTY: VibeAgentsParseResult = { agents: [], problems: [] };

/**
 * Разбор содержимого `.vibe/agents.json`.
 *
 * Одна опечатка не отменяет остальных агентов: запись без `id` или без `command` пропускается с
 * жалобой. Беда верхнего уровня (не JSON, нет массива `agents`) отключает файл целиком — здесь
 * угадывать нечего.
 */
export function parseVibeAgentsFile(text: string): VibeAgentsParseResult {
	const parsed = safeParseConfigJson<Record<string, unknown>>(text);
	if (!parsed.ok) {
		return { agents: [], problems: [`файл не разобран как JSON (${parsed.reason})`] };
	}
	const raw = parsed.value['agents'];
	if (!Array.isArray(raw)) {
		return { agents: [], problems: ['в файле нет массива "agents"'] };
	}

	const agents: VibeAgentEntry[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();

	for (const [index, item] of raw.entries()) {
		const entry = validateEntry(item, index, seen);
		if (typeof entry === 'string') { problems.push(entry); continue; }
		seen.add(entry.id);
		agents.push(entry);
	}
	return { agents, problems };
}

/** Пустой ввод — не ошибка: файла просто нет. */
export function parseVibeAgentsFileOrEmpty(text: string | undefined): VibeAgentsParseResult {
	return text && text.trim() ? parseVibeAgentsFile(text) : EMPTY;
}

/** Только те, кого действительно предлагать. */
export const activeAgents = (agents: readonly VibeAgentEntry[]): readonly VibeAgentEntry[] =>
	agents.filter(agent => agent.active !== false);

function validateEntry(item: unknown, index: number, seen: ReadonlySet<string>): VibeAgentEntry | string {
	if (!item || typeof item !== 'object' || Array.isArray(item)) {
		return `запись №${index + 1}: не объект`;
	}
	const record = item as Record<string, unknown>;
	const id = stringOf(record['id']);
	if (!id) { return `запись №${index + 1}: нет "id"`; }
	if (seen.has(id)) { return `запись "${id}": такой id уже есть`; }
	const command = stringOf(record['command']);
	if (!command) { return `запись "${id}": нет "command"`; }

	const args = record['args'];
	if (args !== undefined && (!Array.isArray(args) || args.some(arg => typeof arg !== 'string'))) {
		return `запись "${id}": "args" — список строк, по одной на аргумент`;
	}
	const env = record['env'];
	if (env !== undefined && !isStringMap(env)) {
		return `запись "${id}": "env" — пары «имя: значение», значения строками`;
	}

	return {
		id,
		command,
		...(stringOf(record['name']) ? { name: stringOf(record['name'])! } : {}),
		...(record['active'] === false ? { active: false } : {}),
		...(args ? { args: [...(args as string[])] } : {}),
		...(env ? { env: { ...(env as Record<string, string>) } } : {}),
		...(stringOf(record['dir']) ? { dir: stringOf(record['dir'])! } : {}),
	};
}

const stringOf = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isStringMap = (value: unknown): boolean =>
	!!value && typeof value === 'object' && !Array.isArray(value)
	&& Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string');
