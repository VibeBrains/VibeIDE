/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pinned MCP tool definitions: what was approved, compared with what the server offers now.
 *
 * A server can change a tool after it was approved. The Deadbugz campaign (Pillar Security, August
 * 2026) served two harmless tools and, after exactly three calls, rewrote their metadata into
 * instructions to hunt for SSH keys and cloud credentials. A tool description reaches the model word
 * for word, so a changed description of an allowed tool is an instruction nobody reviewed. The `tools`
 * list of an mcp.json entry cannot catch that: it pins which tools exist, not what they say.
 *
 * The first listing of a server is pinned silently — adding the server to mcp.json is the consent.
 * A later change or addition is withheld from the model until a person looks at it; a removal needs
 * no look, a missing tool instructs nobody. The pin covers everything the model reads or we act on:
 * name, title, description, both schemas, annotations and the MCP Apps block that decides visibility.
 *
 * What this does NOT catch: a server that keeps its definitions and changes what its calls return.
 * Tool output is covered elsewhere: `untrustedToolOutputGuard` flags it and the system prompt says it is data, not instructions
 *
 * Сравнение идёт по смыслу определения, а не по его записи — см. `comparableDefinition`.
 * Сохранённый текст остаётся читаемым: его показывает сравнение «одобрено ↔ сейчас».
 * Нормализуется текст только при сверке.
 */

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { MCPConfigFileEntryJSON, MCPTool } from './mcpServiceTypes.js';

/** Tool definitions of one server: tool name → canonical text. */
export type McpToolDefinitions = Readonly<Record<string, string>>;

/** How the current definitions differ from the pinned ones; names sorted. */
export interface McpToolDrift {
	readonly changed: readonly string[];
	readonly added: readonly string[];
	readonly removed: readonly string[];
}

/** A tool's definition as the model sees it, in a stable textual form: keys sorted, nothing volatile. */
export function canonicalToolDefinition(tool: MCPTool): string {
	// `title` and `outputSchema` are in the MCP tool shape but not in our type: read them defensively.
	const raw = tool as MCPTool & { readonly title?: unknown; readonly outputSchema?: unknown };
	const ui = (tool._meta as { readonly ui?: unknown } | undefined)?.ui;
	return stableStringify({
		name: tool.name,
		title: raw.title ?? null,
		description: tool.description ?? null,
		inputSchema: tool.inputSchema ?? null,
		outputSchema: raw.outputSchema ?? null,
		annotations: tool.annotations ?? null,
		ui: ui ?? null,
	});
}

export function toolDefinitionsOf(tools: readonly MCPTool[]): McpToolDefinitions {
	const definitions: Record<string, string> = {};
	for (const tool of tools) {
		definitions[tool.name] = canonicalToolDefinition(tool);
	}
	return definitions;
}

export function diffToolDefinitions(pinned: McpToolDefinitions, current: McpToolDefinitions): McpToolDrift {
	const changed: string[] = [];
	const added: string[] = [];
	for (const name of Object.keys(current)) {
		if (!Object.hasOwn(pinned, name)) {
			added.push(name);
		} else if (pinned[name] !== current[name]
			&& comparableDefinition(pinned[name]) !== comparableDefinition(current[name])) {
			changed.push(name);
		}
	}
	const removed = Object.keys(pinned).filter(name => !Object.hasOwn(current, name));
	return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

/** Ключевые слова схемы, значение которых — множество: порядок элементов не значим. */
const UNORDERED_KEYWORDS: ReadonlySet<string> = new Set(['required', 'enum', 'type']);
/** Ключевые слова схемы, значение которых — подсказка-значение: сравнивается набор слов. */
const HINT_KEYWORDS: ReadonlySet<string> = new Set(['default', 'examples', 'example']);
/**
 * Ключевые слова, чьё значение — таблица «имя → схема»
 * Ключи в ней имена, а не ключевые слова: свойство вправе зваться `default`
 */
const SCHEMA_TABLE_KEYWORDS: ReadonlySet<string> = new Set([
	'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas',
]);
/** Разделители слов в подсказке: пробелы и те, которыми склеивают список в строку. */
const HINT_SEPARATORS = /[\s,;|]+/;

/**
 * Определение в виде, пригодном для сверки: то, что сервер вправе переставлять, приведено к одному порядку.
 *
 * Отпечаток нужен, чтобы сервер не мог молча подменить то, что читает модель.
 * Подмену делают новыми словами: приказом в описании, новым параметром, новым значением.
 * Перестановка уже одобренных слов модели нового не говорит.
 * Между тем сервер, собирающий список из множества (set в Python, HashSet на JVM), отдаёт его в другом порядке
 * при каждом запуске, и без этого различия каждый запуск выглядел бы подменой, а «Принять» не помогало бы:
 * следующий порядок снова другой.
 *
 * Что сравнивается по смыслу:
 * - `required`, `enum`, `type` массивом: по JSON Schema это множества, порядок в них ничего не значит
 * - `default`, `examples`, `example`: подсказки-значения, сравнивается набор слов без порядка
 *   Новое слово в подсказке — изменение, как и новое слово в описании: подсказка тоже доходит до модели
 *
 * Что сравнивается слово в слово и в том же порядке: всё остальное, включая каждое `description` и `title`.
 * Описание — проза, обращённая к модели, и порядок слов в нём меняет смысл.
 * Неразобранный текст возвращается как есть: чужую запись лучше показать изменением, чем пропустить.
 */
export function comparableDefinition(canonical: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(canonical);
	} catch {
		return canonical;
	}
	if (!isRecord(parsed)) {
		return canonical;
	}
	return stableStringify({
		...parsed,
		inputSchema: comparableSchema(parsed['inputSchema']),
		outputSchema: comparableSchema(parsed['outputSchema']),
	});
}

function comparableSchema(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map(comparableSchema);
	}
	if (!isRecord(node)) {
		return node;
	}
	const result: Record<string, unknown> = {};
	for (const [keyword, value] of Object.entries(node)) {
		if (HINT_KEYWORDS.has(keyword)) {
			result[keyword] = { words: hintWords(value) };
		} else if (UNORDERED_KEYWORDS.has(keyword) && Array.isArray(value)) {
			// Элементы — данные, а не схемы: порядок убирается, внутрь не заходим
			result[keyword] = value.map(item => stableStringify(item)).sort();
		} else if (SCHEMA_TABLE_KEYWORDS.has(keyword) && isRecord(value)) {
			result[keyword] = Object.fromEntries(
				Object.entries(value).map(([name, schema]) => [name, comparableSchema(schema)]),
			);
		} else if (keyword === 'const') {
			result[keyword] = value;
		} else {
			result[keyword] = comparableSchema(value);
		}
	}
	return result;
}

/** Слова подсказки по всем листьям значения, отсортированные: строка списка, массив и объект сводятся к одному виду. */
function hintWords(value: unknown): string[] {
	const words: string[] = [];
	collectHintWords(value, words);
	return words.sort();
}

function collectHintWords(value: unknown, into: string[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectHintWords(item, into);
		}
	} else if (isRecord(value)) {
		for (const [key, item] of Object.entries(value)) {
			into.push(...splitHintWords(key));
			collectHintWords(item, into);
		}
	} else {
		into.push(...splitHintWords(String(value)));
	}
}

function splitHintWords(text: string): string[] {
	return text.split(HINT_SEPARATORS).filter(word => word !== '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Тексты определений совпадают буква в букву: нечего ни показывать, ни перезаписывать. */
export function identicalDefinitions(a: McpToolDefinitions, b: McpToolDefinitions): boolean {
	const names = Object.keys(a);
	return names.length === Object.keys(b).length && names.every(name => Object.hasOwn(b, name) && a[name] === b[name]);
}

/** Tools the model must not see until a person has looked: changed and added ones. */
export function withheldToolsOf(drift: McpToolDrift): ReadonlySet<string> {
	return new Set([...drift.changed, ...drift.added]);
}

/**
 * Which pin a server's tools are compared with: its name AND what it runs.
 *
 * A person who edits the command or the address of an entry has consented to a different server, so
 * that server starts from a fresh pin rather than being judged against another one's tools. A server
 * whose package updates itself under the same command (`npx some-server`) keeps its pin — exactly the
 * case a pin exists for.
 */
export function serverPinKey(name: string, entry: MCPConfigFileEntryJSON | undefined): string {
	const target = entry?.url !== undefined
		? String(entry.url)
		: [entry?.command ?? '', ...(entry?.args ?? [])].join('\u0001');
	return `${name}\u0000${target}`;
}

/** A pinned definition set pretty-printed for a person, only the named tools; absent tools print as `null`. */
export function describeDefinitions(definitions: McpToolDefinitions, names: readonly string[]): string {
	const shown: Record<string, unknown> = {};
	for (const name of names) {
		shown[name] = Object.hasOwn(definitions, name) ? JSON.parse(definitions[name]) : null;
	}
	return `${JSON.stringify(shown, null, 2)}\n`;
}

/** Storage key of the pins; bump the suffix if the canonical form ever changes. */
export const MCP_TOOL_PINS_STORAGE_KEY = 'vibeide.mcp.toolPins.v1';

/**
 * Pins live in the profile with a MACHINE target, like skill approvals: a repository can neither bring
 * its own pins nor switch the check off, and pins do not travel to another machine through sync.
 */
export class McpToolPinsStore {

	constructor(private readonly _storage: IStorageService) { }

	get(key: string): McpToolDefinitions | undefined {
		return this._readAll()[key];
	}

	set(key: string, definitions: McpToolDefinitions): void {
		const all = { ...this._readAll(), [key]: { ...definitions } };
		this._storage.store(MCP_TOOL_PINS_STORAGE_KEY, JSON.stringify(all), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private _readAll(): Record<string, McpToolDefinitions> {
		const raw = this._storage.get(MCP_TOOL_PINS_STORAGE_KEY, StorageScope.PROFILE);
		if (!raw) {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, McpToolDefinitions> : {};
		} catch {
			// A damaged record is treated as none: every server gets pinned afresh, nothing is unblocked.
			return {};
		}
	}
}

/** JSON with object keys sorted at every level, so equal definitions always print equal. */
function stableStringify(value: unknown): string {
	return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (value && typeof value === 'object') {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}
