/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { McpInputRequest } from './mcpMultiRoundTrip.js';

/**
 * Просьба сервера о вводе, разобранная до формы, которую можно показать человеку.
 *
 * MRTR (SEP-2322) заменил встречные запросы конвертом `input_required`, но сами просьбы внутри
 * него — прежние методы протокола. Отвечать на них по-разному:
 *
 *   - `elicitation/create` — вопрос ЧЕЛОВЕКУ. Схема допускает только простые поля (строка, число,
 *     булево, перечисление): спека запрещает вложенные объекты именно для того, чтобы клиент мог
 *     показать вопрос формой, а не редактором JSON;
 *   - `roots/list` — вопрос про ОТКРЫТЫЕ ПАПКИ. Человека тут спрашивать не о чем: ответ у окна и
 *     так есть, а лишний диалог превратил бы обычный вызов инструмента в допрос;
 *   - всё остальное, включая `sampling/createMessage`, — не отвечаем. Сэмплинг объявлен устаревшим
 *     в той же ревизии, что ввела MRTR, и растить его ради совместимости значит закреплять то, от
 *     чего протокол уходит.
 */

/** Сколько раз подряд сервер может попросить ввод по одному вызову инструмента. */
export const MAX_INPUT_ROUNDS = 3;

export type ElicitationFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum';

export interface ElicitationField {
	readonly key: string;
	/** Подпись для человека: `title` схемы, иначе имя поля — выдумывать нечего. */
	readonly label: string;
	readonly description?: string;
	readonly type: ElicitationFieldType;
	/** Варианты для `enum`; для остальных типов пусто. */
	readonly options?: readonly string[];
	readonly required: boolean;
}

export interface ElicitationForm {
	readonly message: string;
	readonly fields: readonly ElicitationField[];
}

/** Ответ на `elicitation/create` в том виде, в каком его ждёт сервер. */
export type ElicitationAnswer =
	| { readonly action: 'accept'; readonly content: Record<string, unknown> }
	| { readonly action: 'decline' }
	| { readonly action: 'cancel' };

/** На что мы умеем отвечать, а на что нет — до того, как беспокоить человека. */
export interface InputRequestPlan {
	readonly elicitations: readonly { readonly request: McpInputRequest; readonly form: ElicitationForm }[];
	readonly roots: readonly McpInputRequest[];
	/** Методы, отвечать на которые мы не умеем: вызов отклоняется целиком и говорит почему. */
	readonly unsupported: readonly string[];
}

const stringsOf = (value: unknown): string[] | undefined =>
	Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;

/**
 * Разобрать параметры `elicitation/create`.
 *
 * `undefined` — показать нечего: без сообщения и без полей диалог спросил бы пустоту, а принять
 * такую просьбу за отвеченную значило бы соврать серверу.
 */
export function parseElicitationParams(params: unknown): ElicitationForm | undefined {
	if (!params || typeof params !== 'object') { return undefined; }
	const bag = params as Record<string, unknown>;
	const message = typeof bag.message === 'string' ? bag.message.trim() : '';
	const schema = bag.requestedSchema as Record<string, unknown> | undefined;
	const properties = schema?.properties && typeof schema.properties === 'object'
		? schema.properties as Record<string, unknown>
		: undefined;
	if (!message && !properties) { return undefined; }

	const required = new Set(stringsOf(schema?.required) ?? []);
	const fields: ElicitationField[] = [];
	for (const [key, raw] of Object.entries(properties ?? {})) {
		const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
		const options = stringsOf(entry.enum);
		const declared = typeof entry.type === 'string' ? entry.type : 'string';
		// Вложенные объекты и списки схема elicitation не допускает; пришедшее вопреки спеке
		// показывается строкой, а не молча теряется — человек хотя бы увидит, что у него просят.
		const type: ElicitationFieldType = options ? 'enum'
			: declared === 'number' ? 'number'
				: declared === 'integer' ? 'integer'
					: declared === 'boolean' ? 'boolean'
						: 'string';
		fields.push({
			key,
			label: typeof entry.title === 'string' && entry.title.trim() ? entry.title.trim() : key,
			...(typeof entry.description === 'string' && entry.description.trim() ? { description: entry.description.trim() } : {}),
			type,
			...(options ? { options } : {}),
			required: required.has(key),
		});
	}
	return { message, fields };
}

/**
 * Разложить просьбы сервера по тому, чем на них отвечать.
 *
 * Считается ДО показа диалога: если среди просьб есть хоть одна, на которую мы ответить не умеем,
 * повтор вызова всё равно не состоится — и спрашивать человека значило бы потратить его время зря.
 */
export function planInputRequests(requests: readonly McpInputRequest[]): InputRequestPlan {
	const elicitations: { request: McpInputRequest; form: ElicitationForm }[] = [];
	const roots: McpInputRequest[] = [];
	const unsupported: string[] = [];
	for (const request of requests) {
		if (request.method === 'elicitation/create') {
			const form = parseElicitationParams(request.params);
			if (form) { elicitations.push({ request, form }); } else { unsupported.push(`${request.method} (пустая просьба)`); }
			continue;
		}
		if (request.method === 'roots/list') {
			roots.push(request);
			continue;
		}
		unsupported.push(request.method);
	}
	return { elicitations, roots, unsupported };
}

/**
 * Значение поля из строки, введённой человеком.
 *
 * Нечисловой ввод в числовом поле возвращается строкой: подменять его нулём значило бы отправить
 * серверу число, которого человек не вводил.
 */
export function coerceFieldValue(field: ElicitationField, raw: string): unknown {
	if (field.type === 'boolean') { return raw === 'true'; }
	if (field.type === 'number' || field.type === 'integer') {
		const parsed = field.type === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : raw;
	}
	return raw;
}

/** Ответы на `roots/list`: папки окна в том виде, в каком их ждёт протокол. */
export function rootsAnswer(folders: readonly { readonly uri: string; readonly name: string }[]): { roots: { uri: string; name: string }[] } {
	return { roots: folders.map(folder => ({ uri: folder.uri, name: folder.name })) };
}

/**
 * Что главный процесс просит у окна: показать вопросы и вернуть ответы.
 *
 * Ключи — те же, под которыми сервер прислал просьбы: ответ кладётся обратно ровно под ними,
 * иначе сервер не найдёт того, что просил.
 */
export interface McpInputAsk {
	readonly requestId: string;
	readonly serverName: string;
	readonly toolName: string;
	readonly elicitations: readonly { readonly key: string; readonly form: ElicitationForm }[];
	/** Ключи просьб `roots/list`: окно отвечает само, человека не спрашивая. */
	readonly rootKeys: readonly string[];
}

/**
 * Ответ окна.
 *
 * Отказ — это исход, а не сбой: человек вправе закрыть вопрос, и серверу об этом сообщается
 * положенным ему словом (`decline` / `cancel`), а не молчанием.
 */
export type McpInputAnswer =
	| { readonly ok: true; readonly responses: Record<string, unknown> }
	| { readonly ok: false; readonly reason: string };

/**
 * Читаемое объяснение отказа подключиться из-за ревизии протокола.
 *
 * `undefined` — отказ не про ревизию, и выдумывать объяснение нельзя.
 *
 * Проверено стендом 20.09.2026: клиент SDK 1.29.0 объявляет максимум `2025-11-25`, а сервер,
 * настаивающий на `2026-07-28` (ревизия, которая и ввела MRTR), получает отказ ещё на рукопожатии —
 * с английской строкой из недр SDK, по которой пользователю не понять ни причины, ни что делать.
 */
export function describeProtocolMismatch(error: unknown): string | undefined {
	const text = error instanceof Error ? error.message : String(error ?? '');
	const match = /protocol version is not supported:\s*(\S+)/i.exec(text);
	if (!match) { return undefined; }
	return `Сервер говорит на ревизии протокола ${match[1]}, а клиент MCP внутри VibeIDE её пока не знает — соединение отклонено на рукопожатии. `
		+ 'Это не ошибка настройки: поддержка ревизии приезжает с обновлением клиента. '
		+ 'Если у сервера есть режим совместимости с более ранней ревизией — включите его на его стороне.';
}
