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

	/**
	 * MCP-серверы проекта, которые этот гость получает при создании сессии, — поимённо.
	 *
	 * Отсутствует или пусто — гость не получает ни одного: ACP передаёт ему КОНФИГУРАЦИИ серверов
	 * (вместе с `env` и `headers`, а там бывают ключи), и он подключается к ним сам. «Отдать всё»
	 * поэтому не предусмотрено даже как значение: список, растущий сам при добавлении сервера в
	 * `mcp.json`, однажды увёз бы гостю то, чего человек не имел в виду.
	 */
	readonly mcpServers?: readonly string[];

	/**
	 * Where the entry came from when it was added from the ACP Registry: the agent's id there and the
	 * version written into this entry. The pane compares it with the registry to offer an update; a
	 * hand-written entry has no such field and is never touched by an update.
	 */
	readonly registry?: VibeAgentRegistryOrigin;
}

/** The ACP Registry entry an agent was added from, and the version this entry runs. */
export interface VibeAgentRegistryOrigin {
	readonly id: string;
	readonly version: string;
}

/** Which file an agent comes from. The project file travels with the repository; the machine file stays here. */
export type VibeAgentLayer = 'project' | 'machine';

/**
 * Where a listed agent comes from: one of our two files, or JetBrains' `~/.jetbrains/acp.json`, which is read and never
 * written — VibeIDEA and the JetBrains IDEs install and update agents there, and a copy of theirs would go stale
 */
export type VibeAgentSource = VibeAgentLayer | 'jetbrains';

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
	const mcpServers = record['mcpServers'];
	if (mcpServers !== undefined && (!Array.isArray(mcpServers) || mcpServers.some(name => typeof name !== 'string'))) {
		return `запись "${id}": "mcpServers" — список имён серверов из mcp.json, строками`;
	}
	const registry = record['registry'];
	const registryId = registry && typeof registry === 'object' ? stringOf((registry as Record<string, unknown>)['id']) : undefined;
	const registryVersion = registry && typeof registry === 'object' ? stringOf((registry as Record<string, unknown>)['version']) : undefined;
	if (registry !== undefined && (!registryId || !registryVersion)) {
		return `запись "${id}": "registry" — объект { "id", "version" } из реестра ACP`;
	}

	return {
		id,
		command,
		...(stringOf(record['name']) ? { name: stringOf(record['name'])! } : {}),
		...(record['active'] === false ? { active: false } : {}),
		...(args ? { args: [...(args as string[])] } : {}),
		...(env ? { env: { ...(env as Record<string, string>) } } : {}),
		...(stringOf(record['dir']) ? { dir: stringOf(record['dir'])! } : {}),
		...(mcpServers ? { mcpServers: [...(mcpServers as string[])] } : {}),
		...(registryId && registryVersion ? { registry: { id: registryId, version: registryVersion } } : {}),
	};
}

/**
 * `~/.jetbrains/acp.json` — the agents a JetBrains IDE or VibeIDEA runs over ACP
 *
 * Format: `{ "agent_servers": { "<display name>": { "command", "args"?, "env"? } } }`
 * (blog.jetbrains.com/idea/2026/08/how-to-use-ai-agents-in-intellij-idea-with-acp)
 * The key is a display name, so the id is derived from it: lower case, anything but letters and digits a dash
 * A broken entry is skipped with a complaint, as in our own file
 */
export function parseJetBrainsAcpFile(text: string | undefined): VibeAgentsParseResult {
	if (!text || !text.trim()) {
		return EMPTY;
	}
	const parsed = safeParseConfigJson<Record<string, unknown>>(text);
	if (!parsed.ok) {
		return { agents: [], problems: [`файл не разобран как JSON (${parsed.reason})`] };
	}
	const servers = parsed.value['agent_servers'];
	if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
		return { agents: [], problems: ['в файле нет объекта "agent_servers"'] };
	}
	const agents: VibeAgentEntry[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const [name, item] of Object.entries(servers as Record<string, unknown>)) {
		const id = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
		if (!id) {
			problems.push(`агент «${name}»: из имени не получается id`);
			continue;
		}
		const entry = validateEntry(item && typeof item === 'object' && !Array.isArray(item) ? { ...(item as Record<string, unknown>), id, name } : item, agents.length + problems.length, seen);
		if (typeof entry === 'string') {
			problems.push(entry);
			continue;
		}
		seen.add(entry.id);
		agents.push(entry);
	}
	return { agents, problems };
}

/**
 * Agents of the three sources as one list. The project entry wins over a machine entry with the same id — the team's
 * choice is stronger than one machine's — and the machine entry wins over JetBrains', our own file over another
 * product's. Project agents come first, then machine-only, then JetBrains-only, each in its own order. Each agent is
 * returned with its source, because adding and updating write back to that same file, and JetBrains' file is not ours.
 */
export function mergeAgentLayers(machine: readonly VibeAgentEntry[], project: readonly VibeAgentEntry[], jetbrains: readonly VibeAgentEntry[] = []): readonly { readonly agent: VibeAgentEntry; readonly layer: VibeAgentSource }[] {
	const projectIds = new Set(project.map(agent => agent.id));
	const machineOnly = machine.filter(agent => !projectIds.has(agent.id));
	const ours = new Set([...projectIds, ...machineOnly.map(agent => agent.id)]);
	return [
		...project.map(agent => ({ agent, layer: 'project' as const })),
		...machineOnly.map(agent => ({ agent, layer: 'machine' as const })),
		...jetbrains.filter(agent => !ours.has(agent.id)).map(agent => ({ agent, layer: 'jetbrains' as const })),
	];
}

const stringOf = (value: unknown): string | undefined =>
	typeof value === 'string' && value.trim() ? value.trim() : undefined;

const isStringMap = (value: unknown): boolean =>
	!!value && typeof value === 'object' && !Array.isArray(value)
	&& Object.values(value as Record<string, unknown>).every(entry => typeof entry === 'string');
