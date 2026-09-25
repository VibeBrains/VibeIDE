/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Client Protocol — транспорт и диспетчер, чистая часть.
 *
 * ACP описывает разговор редактора с внешним агентом поверх JSON-RPC 2.0: агент живёт отдельным
 * процессом, редактор даёт ему файлы, терминал и разрешения. Ради этого разговора всё и затевалось:
 * работа внешнего агента должна быть видна IDE так же, как работа собственного.
 *
 * Живой прогон с Claude Code поправил замысел в важном месте. Клиентскую файловую систему
 * (`fs/read_text_file`, `fs/write_text_file`) он не вызывает вовсе — правит своими инструментами,
 * а нам присылает вызов инструмента с готовым диффом и спрашивает разрешение ДО применения.
 * Значит воротами служит не запись файла, а `session/request_permission` и кадры `tool_call`:
 * в них есть и путь, и «было → стало». Клиентская ФС остаётся реализованной — ею пользуются
 * другие агенты, — но полагаться на неё как на единственный источник правды нельзя.
 *
 * Модуль занимается ровно двумя вещами: режет поток на сообщения и разводит их по обработчикам.
 * Ни процессов, ни файловой системы — поэтому проверяется из `test/common/`.
 */

/** Версия протокола, с которой мы здороваемся. Согласование возвращает агент в ответе. */
export const ACP_PROTOCOL_VERSION = 1;

/** Методы, которые вызывает КЛИЕНТ (мы) у агента. */
export const ACP_AGENT_METHOD = {
	initialize: 'initialize',
	authenticate: 'authenticate',
	newSession: 'session/new',
	loadSession: 'session/load',
	resumeSession: 'session/resume',
	prompt: 'session/prompt',
	cancel: 'session/cancel',
	setConfigOption: 'session/set_config_option',
	closeSession: 'session/close',
} as const;

/** Методы, которые агент вызывает у НАС. Реализовать их — и значит быть хостом. */
export const ACP_CLIENT_METHOD = {
	requestPermission: 'session/request_permission',
	readTextFile: 'fs/read_text_file',
	writeTextFile: 'fs/write_text_file',
	sessionUpdate: 'session/update',
} as const;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface IJsonRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly method: string;
	readonly params?: JsonValue;
}

export interface IJsonRpcNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: JsonValue;
}

export interface IJsonRpcResponse {
	readonly jsonrpc: '2.0';
	readonly id: number | string;
	readonly result?: JsonValue;
	readonly error?: { readonly code: number; readonly message: string; readonly data?: JsonValue };
}

export type JsonRpcMessage = IJsonRpcRequest | IJsonRpcNotification | IJsonRpcResponse;

/** Коды ошибок JSON-RPC, которые мы реально отдаём. */
export const JSON_RPC_ERROR = {
	parse: -32700,
	invalidRequest: -32600,
	methodNotFound: -32601,
	internal: -32603,
} as const;

/**
 * Разбор потока на сообщения.
 *
 * ACP передаёт по одному JSON на строку (`\n`-разделённый поток stdio). Приёмник накапливает
 * хвост, потому что процесс отдаёт данные кусками произвольного размера, и сообщение почти всегда
 * приходит разрезанным — читать каждый кусок как готовый JSON значит терять их все.
 *
 * Битая строка не роняет разбор: она возвращается отдельным списком. Агент может напечатать в
 * stdout что угодно — предупреждение рантайма, отладочную строку, — и обрыв связи из-за чужого
 * `console.log` был бы худшим способом узнать об этом.
 */
export class AcpStreamDecoder {
	private _tail = '';

	push(chunk: string): { readonly messages: JsonRpcMessage[]; readonly garbage: string[] } {
		const messages: JsonRpcMessage[] = [];
		const garbage: string[] = [];
		this._tail += chunk;

		let newline = this._tail.indexOf('\n');
		while (newline !== -1) {
			const line = this._tail.slice(0, newline).trim();
			this._tail = this._tail.slice(newline + 1);
			newline = this._tail.indexOf('\n');
			if (!line) { continue; }
			const parsed = parseMessage(line);
			if (parsed) { messages.push(parsed); } else { garbage.push(line); }
		}
		return { messages, garbage };
	}

	/** Сколько байт ждёт продолжения — для диагностики зависшего агента. */
	get pending(): number {
		return this._tail.length;
	}
}

/** Разбор одной строки. `undefined` — не наше сообщение, а не исключение. */
export function parseMessage(line: string): JsonRpcMessage | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) { return undefined; }
	const record = value as Record<string, unknown>;
	if (record['jsonrpc'] !== '2.0') { return undefined; }
	const hasId = record['id'] !== undefined && record['id'] !== null;
	const hasMethod = typeof record['method'] === 'string';
	if (hasMethod) {
		return hasId ? (record as unknown as IJsonRpcRequest) : (record as unknown as IJsonRpcNotification);
	}
	// Ответ обязан нести id: без него непонятно, на что он отвечает, и связать его не с чем.
	return hasId ? (record as unknown as IJsonRpcResponse) : undefined;
}

export const isRequest = (message: JsonRpcMessage): message is IJsonRpcRequest =>
	typeof (message as IJsonRpcRequest).method === 'string' && (message as IJsonRpcRequest).id !== undefined;

export const isNotification = (message: JsonRpcMessage): message is IJsonRpcNotification =>
	typeof (message as IJsonRpcNotification).method === 'string' && (message as IJsonRpcRequest).id === undefined;

export const isResponse = (message: JsonRpcMessage): message is IJsonRpcResponse =>
	typeof (message as IJsonRpcRequest).method !== 'string' && (message as IJsonRpcResponse).id !== undefined;

/** Сериализация: одно сообщение — одна строка. */
export const encodeMessage = (message: JsonRpcMessage): string => `${JSON.stringify(message)}\n`;

export const requestFrame = (id: number, method: string, params?: JsonValue): IJsonRpcRequest =>
	({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

export const resultFrame = (id: number | string, result: JsonValue): IJsonRpcResponse =>
	({ jsonrpc: '2.0', id, result });

export const errorFrame = (id: number | string, code: number, message: string): IJsonRpcResponse =>
	({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * Параметры `initialize`.
 *
 * Возможности объявляются честно: `fs.readTextFile`/`writeTextFile` — потому что мы их реально
 * обслуживаем. Заявить возможность, которой нет, значит получить от агента запрос, на который
 * придётся ответить ошибкой в середине его работы.
 */
export const initializeParams = (): JsonValue => ({
	protocolVersion: ACP_PROTOCOL_VERSION,
	clientCapabilities: {
		fs: { readTextFile: true, writeTextFile: true },
		terminal: false,
		// The session header shows an on/off option as a checkbox: without this an agent must not send one
		session: { configOptions: { boolean: {} } },
	},
	clientInfo: { name: 'VibeIDE', version: '1' },
});

/**
 * Объявил ли агент поддержку MCP поверх HTTP (`agentCapabilities.mcpCapabilities.http`).
 *
 * Stdio-серверы спецификация объявляет поддержанными всегда, а HTTP — только по этому флагу.
 * Отправить HTTP-запись агенту, который её не понимает, значит получить у него молча неработающий
 * сервер: он не обязан ни отказать, ни пожаловаться.
 */
export function agentSupportsHttpMcp(greeting: JsonValue): boolean {
	const caps = (greeting as { agentCapabilities?: { mcpCapabilities?: { http?: unknown } } } | null)?.agentCapabilities;
	return caps?.mcpCapabilities?.http === true;
}

/** Способ войти, объявленный агентом в ответе на `initialize`. */
export interface IAcpAuthMethod {
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

/**
 * Способы входа из ответа на `initialize`.
 *
 * Нужны не для автоматического входа, а для честного сообщения человеку: агент, отвечающий на ход
 * «Authentication required», без этого списка не объясняет, ЧТО делать. Claude Code, например,
 * ждёт `claude /login` в терминале и метод `authenticate` не реализует вовсе.
 */
export function authMethodsOf(initializeResult: JsonValue | undefined): readonly IAcpAuthMethod[] {
	const raw = asObject(initializeResult)?.['authMethods'];
	if (!Array.isArray(raw)) { return []; }
	const methods: IAcpAuthMethod[] = [];
	for (const entry of raw) {
		const record = asObject(entry);
		const id = stringAt(record, 'id');
		if (!id) { continue; }
		methods.push({ id, name: stringAt(record, 'name') ?? id, description: stringAt(record, 'description') ?? '' });
	}
	return methods;
}

/**
 * Параметры `session/new`. Путь обязан быть абсолютным — это требование спецификации.
 *
 * Пустой список, а не отсутствие поля: спецификация объявляет `mcpServers` обязательным, и агент
 * вправе отказать в создании сессии, не найдя его. Непустой список — это КОНФИГУРАЦИИ серверов, к
 * которым гость подключается сам (правила отбора — `acpMcpExport.ts`).
 */
export const newSessionParams = (cwd: string, mcpServers: readonly JsonValue[] = []): JsonValue => ({
	cwd,
	mcpServers: [...mcpServers],
});

/**
 * How a session whose agent process died can come back, strongest first.
 *
 * - `resume` — the same session, and the agent does not replay the history: the transcript the person
 *   sees is already ours, so nothing is duplicated.
 * - `load` — the same session, but the agent replays the whole conversation before answering; the
 *   host has to swallow the replay, or the feed and the journal would show everything twice.
 * - `new` — a fresh session: the agent does not remember what was said, and the person must be told.
 */
export type AcpReconnectMode = 'resume' | 'load' | 'new';

/**
 * The ways back this agent declared in its `initialize` answer, strongest first; `new` always ends
 * the list. `session/resume` is declared by the presence of `agentCapabilities.sessionCapabilities.resume`
 * (an object), `session/load` by `agentCapabilities.loadSession === true`. Calling either without the
 * declaration is forbidden by the spec.
 */
export function reconnectModesOf(greeting: JsonValue | undefined): readonly AcpReconnectMode[] {
	const caps = asObject(asObject(greeting)?.['agentCapabilities']);
	const modes: AcpReconnectMode[] = [];
	// The schema makes `resume` an object; an agent sending `true` has declared it just the same.
	const resume = asObject(caps?.['sessionCapabilities'])?.['resume'];
	if (resume === true || asObject(resume)) {
		modes.push('resume');
	}
	if (caps?.['loadSession'] === true) {
		modes.push('load');
	}
	modes.push('new');
	return modes;
}

/**
 * Whether the agent declared `session/close` (`agentCapabilities.sessionCapabilities.close`)
 * Without it a session is ended by ending the process; calling an undeclared method is forbidden by the spec
 */
export function agentSupportsClose(greeting: JsonValue | undefined): boolean {
	const close = asObject(objectAt(asObject(greeting)?.['agentCapabilities'], 'sessionCapabilities'))?.['close'];
	return close === true || !!asObject(close);
}

/** One value of a select option; `group` names the group it came in, when the agent grouped them */
export interface IAcpConfigChoice {
	readonly value: string;
	readonly name: string;
	readonly description?: string;
	readonly group?: string;
}

/**
 * A setting of a guest session the agent exposes: its model, its mode, how hard it thinks
 * `category` is only a hint for placement; the option is identified by `id` alone
 */
export type IAcpConfigOption = {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly category?: string;
} & (
		| { readonly type: 'select'; readonly currentValue: string; readonly choices: readonly IAcpConfigChoice[] }
		| { readonly type: 'boolean'; readonly currentValue: boolean }
	);

/**
 * The session's settings from a response or an update carrying `configOptions`; `undefined` when the field is absent
 * An option of an unknown type, or one whose current value does not match its type, is skipped: a control that
 * cannot show the agent's state would show a false one
 */
export function configOptionsOf(source: JsonValue | undefined): readonly IAcpConfigOption[] | undefined {
	const raw = asObject(source)?.['configOptions'];
	if (!Array.isArray(raw)) { return undefined; }
	const options: IAcpConfigOption[] = [];
	for (const entry of raw) {
		const record = asObject(entry);
		const id = stringAt(record, 'id');
		if (!record || !id) { continue; }
		const base = {
			id,
			name: stringAt(record, 'name') ?? id,
			...(stringAt(record, 'description') ? { description: stringAt(record, 'description') } : {}),
			...(stringAt(record, 'category') ? { category: stringAt(record, 'category') } : {}),
		};
		const current = record['currentValue'];
		if (record['type'] === 'boolean' && typeof current === 'boolean') {
			options.push({ ...base, type: 'boolean', currentValue: current });
		} else if (record['type'] === 'select' && typeof current === 'string') {
			options.push({ ...base, type: 'select', currentValue: current, choices: configChoicesOf(record['options']) });
		}
	}
	return options;
}

/** Values of a select, flat or in groups; the group's name rides on each of its values */
function configChoicesOf(raw: JsonValue | undefined): readonly IAcpConfigChoice[] {
	if (!Array.isArray(raw)) { return []; }
	const choices: IAcpConfigChoice[] = [];
	const push = (entry: JsonValue, group?: string) => {
		const record = asObject(entry);
		const value = stringAt(record, 'value');
		if (!value) { return; }
		const description = stringAt(record, 'description');
		choices.push({ value, name: stringAt(record, 'name') ?? value, ...(description ? { description } : {}), ...(group ? { group } : {}) });
	};
	for (const entry of raw) {
		const record = asObject(entry);
		const nested = record?.['options'];
		if (Array.isArray(nested)) {
			const group = stringAt(record, 'name') ?? stringAt(record, 'group');
			nested.forEach(inner => push(inner, group));
		} else {
			push(entry);
		}
	}
	return choices;
}

/** Params of `session/set_config_option`; a boolean says its type, as the spec asks */
export function setConfigOptionParams(sessionId: string, configId: string, value: string | boolean): JsonValue {
	return typeof value === 'boolean'
		? { sessionId, configId, type: 'boolean', value }
		: { sessionId, configId, value };
}

/** Params of `session/resume` and `session/load`: the same shape, the session to come back to. */
export const returnToSessionParams = (sessionId: string, cwd: string, mcpServers: readonly JsonValue[] = []): JsonValue => ({
	sessionId,
	cwd,
	mcpServers: [...mcpServers],
});

/** Параметры `session/prompt`: сообщение пользователя блоками содержимого. */
export const promptParams = (sessionId: string, text: string): JsonValue => ({
	sessionId,
	prompt: [{ type: 'text', text }],
});

/**
 * Почему агент остановился.
 *
 * Значения приходят от агента как строки; неизвестное не приводится к «завершено» — иначе
 * прерванный ход выглядел бы успешным.
 */
export type AcpStopReason = 'completed' | 'cancelled' | 'refusal' | 'max_turns' | 'max_tokens' | 'unknown';

export function stopReasonOf(raw: unknown): AcpStopReason {
	const value = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
	switch (value) {
		case 'completed':
		case 'end_turn':
			return 'completed';
		case 'cancelled':
		case 'canceled':
			return 'cancelled';
		case 'refusal':
			return 'refusal';
		case 'max_turn_requests':
		case 'reached_max_turns':
		case 'max_turns':
			return 'max_turns';
		case 'max_tokens':
			return 'max_tokens';
		default:
			return 'unknown';
	}
}

/** Правка файла так, как её показывает агент: до и после, без применения. */
export interface IAcpDiff {
	readonly path: string;
	readonly oldText: string;
	readonly newText: string;
}

/** Стадия вызова инструмента. Неизвестное не выдаётся за завершённое. */
/**
 * Стадия вызова инструмента.
 *
 * `cancelled` объявлен в схеме v2 и прислать его вправе любой агент — без ветки он сворачивался
 * в «неизвестно», то есть отменённое выглядело как «непонятно, чем кончилось».
 */
export type AcpToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'unknown';

/**
 * Что приехало в `session/update`.
 *
 * Разбор шире, чем «взять текст», по факту живого прогона: Claude Code клиентскую файловую
 * систему не вызывает — правит сам, а нам присылает вызов инструмента с готовым диффом. Значит
 * единственный достоверный источник знания о правке — эти кадры, и терять их нельзя.
 */
export type AcpUpdate =
	/** Кусок ответа или размышления агента. */
	| { readonly kind: 'text'; readonly text: string; readonly thought: boolean }
	/** Вызов инструмента: чем занят агент и что именно меняет. */
	| { readonly kind: 'tool'; readonly toolCallId: string; readonly title: string; readonly name: string; readonly toolKind: string; readonly status: AcpToolStatus; readonly paths: readonly string[]; readonly diffs: readonly IAcpDiff[] }
	/** Расход контекста и денег за ход. */
	| { readonly kind: 'usage'; readonly used: number; readonly size: number; readonly costUsd?: number }
	/** The agent changed the session's settings itself: the full list, as in a response */
	| { readonly kind: 'config'; readonly options: readonly IAcpConfigOption[] };

/** Разбор уведомления `session/update`. `undefined` — кадр, который нам нечего показать. */
export function parseSessionUpdate(params: JsonValue | undefined): AcpUpdate | undefined {
	const update = objectAt(params, 'update');
	if (!update) { return undefined; }
	// Дискриминатор в спецификации в snake_case, в отличие от остальных полей.
	const kind = update['sessionUpdate'];

	if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
		const text = stringAt(objectAt(update, 'content'), 'text');
		return text ? { kind: 'text', text, thought: kind === 'agent_thought_chunk' } : undefined;
	}

	if (kind === 'tool_call' || kind === 'tool_call_update') {
		const toolCallId = stringAt(update, 'toolCallId');
		if (!toolCallId) { return undefined; }
		const facts = toolCallFacts(update);
		return {
			kind: 'tool',
			toolCallId,
			title: facts.title,
			name: facts.name,
			toolKind: facts.toolKind,
			status: toolStatusOf(update['status']),
			paths: facts.paths,
			diffs: facts.diffs,
		};
	}

	if (kind === 'config_option_update') {
		const options = configOptionsOf(update);
		return options ? { kind: 'config', options } : undefined;
	}

	if (kind === 'usage_update') {
		const used = numberAt(update, 'used');
		const size = numberAt(update, 'size');
		if (used === undefined || size === undefined) { return undefined; }
		const costUsd = numberAt(objectAt(update, 'cost'), 'amount');
		return { kind: 'usage', used, size, ...(costUsd === undefined ? {} : { costUsd }) };
	}

	return undefined;
}

function toolStatusOf(raw: JsonValue | undefined): AcpToolStatus {
	switch (typeof raw === 'string' ? raw : '') {
		case 'pending': return 'pending';
		case 'in_progress': return 'in_progress';
		case 'completed': return 'completed';
		case 'failed': return 'failed';
		case 'cancelled': return 'cancelled';
		default: return 'unknown';
	}
}

/**
 * Факты о вызове инструмента: чем занят агент и чего это касается.
 *
 * Одна и та же форма приходит дважды — уведомлением `tool_call` и внутри
 * `session/request_permission`. Разбор общий: иначе вопрос человеку и журнал правок однажды
 * разойдутся в том, какой файл меняется.
 */
export function toolCallFacts(toolCall: JsonValue | undefined): { readonly title: string; readonly name: string; readonly toolKind: string; readonly paths: readonly string[]; readonly diffs: readonly IAcpDiff[] } {
	const record = asObject(toolCall) ?? {};
	return {
		title: stringAt(record, 'title') ?? '',
		// Программное имя инструмента (`read_file`): стабилизировано в ACP v1 17.09.2026, поле
		// необязательное. В обновлении вызова пусто означает «не менять», а не «стереть», поэтому
		// склейка карточки ниже пустое имя игнорирует.
		name: stringAt(record, 'name') ?? '',
		toolKind: stringAt(record, 'kind') ?? '',
		paths: pathsOf(record),
		diffs: diffsOf(record['content']),
	};
}

/**
 * Файлы, которых касается вызов.
 *
 * Берутся и из `locations`, и из путей диффов, и из аргументов инструмента: живой агент шлёт
 * кадры, где заполнено только одно из трёх, а пропущенный путь означает не снятый чекпоинт.
 */
function pathsOf(update: Record<string, JsonValue>): readonly string[] {
	const found: string[] = [];
	const locations = update['locations'];
	if (Array.isArray(locations)) {
		for (const location of locations) {
			const path = stringAt(asObject(location), 'path');
			if (path) { found.push(path); }
		}
	}
	for (const diff of diffsOf(update['content'])) {
		found.push(diff.path);
	}
	const filePath = stringAt(asObject(update['rawInput']), 'file_path');
	if (filePath) { found.push(filePath); }
	return [...new Set(found)];
}

function diffsOf(content: JsonValue | undefined): readonly IAcpDiff[] {
	if (!Array.isArray(content)) { return []; }
	const diffs: IAcpDiff[] = [];
	for (const entry of content) {
		const record = asObject(entry);
		if (!record || record['type'] !== 'diff') { continue; }
		const path = stringAt(record, 'path');
		if (!path) { continue; }
		// Пустая строка — законное содержимое: так выглядит создание файла и удаление текста.
		diffs.push({ path, oldText: textOrEmpty(record['oldText']), newText: textOrEmpty(record['newText']) });
	}
	return diffs;
}

const textOrEmpty = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : '');

const asObject = (value: JsonValue | undefined): Record<string, JsonValue> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, JsonValue>) : undefined;

const objectAt = (source: JsonValue | undefined, key: string): Record<string, JsonValue> | undefined =>
	asObject(asObject(source)?.[key]);

const stringAt = (source: Record<string, JsonValue> | undefined, key: string): string | undefined => {
	const value = source?.[key];
	return typeof value === 'string' && value ? value : undefined;
};

const numberAt = (source: Record<string, JsonValue> | undefined, key: string): number | undefined => {
	const value = source?.[key];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};
