/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Client Protocol — транспорт и диспетчер, чистая часть.
 *
 * ACP описывает разговор редактора с внешним агентом поверх JSON-RPC 2.0: агент живёт отдельным
 * процессом, редактор даёт ему файлы, терминал и разрешения. Отличие от нашего моста к Claude Code
 * через его SDK принципиальное и стоит того, чтобы быть названным: там агент правит файлы САМ,
 * мимо IDE, поэтому его работы не видят ни чекпоинты, ни снимок рабочей папки, ни журнал правок.
 * Здесь правка приходит запросом `fs/write_text_file` — и проходит через те же ворота, что правка
 * нашего собственного агента.
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
	prompt: 'session/prompt',
	cancel: 'session/cancel',
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
	},
	clientInfo: { name: 'VibeIDE', version: '1' },
});

/** Параметры `session/new`. Путь обязан быть абсолютным — это требование спецификации. */
export const newSessionParams = (cwd: string): JsonValue => ({
	cwd,
	// Пустой список, а не отсутствие поля: спецификация объявляет `mcpServers` обязательным, и
	// агент вправе отказать в создании сессии, не найдя его.
	mcpServers: [],
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

/** Текст из уведомления `session/update`, если это кусок ответа. Иначе `undefined`. */
export function textOfSessionUpdate(params: JsonValue | undefined): string | undefined {
	if (!params || typeof params !== 'object' || Array.isArray(params)) { return undefined; }
	const update = (params as Record<string, JsonValue>)['update'];
	if (!update || typeof update !== 'object' || Array.isArray(update)) { return undefined; }
	const record = update as Record<string, JsonValue>;
	// Дискриминатор в спецификации в snake_case, в отличие от остальных полей.
	const kind = record['sessionUpdate'];
	if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') { return undefined; }
	const content = record['content'];
	if (!content || typeof content !== 'object' || Array.isArray(content)) { return undefined; }
	const text = (content as Record<string, JsonValue>)['text'];
	return typeof text === 'string' && text ? text : undefined;
}
