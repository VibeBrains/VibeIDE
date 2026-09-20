/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Запрос клиента ревизии MCP 2026-07-28 — без сессии и без рукопожатия.
 *
 * WHY: ревизия 2026-07-28 удалила из Streamable HTTP заголовок `Mcp-Session-Id` (SEP-2567) и метод
 * `initialize` целиком (SEP-2575). Версия протокола и возможности клиента теперь едут в `_meta`
 * КАЖДОГО запроса, а сервер обязан отвечать на `server/discover`.
 *
 * Для нашего шлюза это не «поддержать новое», а «перестать отказывать»: обновившийся клиент шлёт
 * `tools/list` без заголовка сессии, и прежний шлюз отвечал ему `400 Missing Mcp-Session-Id header`.
 * То есть мы становились недоступны, а не продолжали работать по-старому.
 */

/** Обязательное поле `_meta` нового клиента: версия протокола, по которой он говорит. */
export const MCP_META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** Обязательное поле `_meta`: возможности клиента, раньше приезжавшие в `initialize`. */
export const MCP_META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
/** Метод, которым клиент узнаёт версии и возможности сервера вместо рукопожатия. */
export const MCP_DISCOVER_METHOD = 'server/discover';

/**
 * Версия протокола из `_meta` запроса, если клиент говорит по правилам новой ревизии.
 *
 * Пусто — это либо старый клиент (он пройдёт через `initialize`), либо не запрос вовсе.
 */
export function statelessProtocolVersionOf(message: unknown): string | undefined {
	const single = Array.isArray(message) ? message[0] : message;
	if (!single || typeof single !== 'object') {
		return undefined;
	}
	const params = (single as { params?: unknown }).params;
	const meta = params && typeof params === 'object' ? (params as { _meta?: unknown })._meta : undefined;
	if (!meta || typeof meta !== 'object') {
		return undefined;
	}
	const version = (meta as Record<string, unknown>)[MCP_META_PROTOCOL_VERSION];
	return typeof version === 'string' && version.trim() ? version : undefined;
}

/** Это запрос `server/discover` — первый и единственный, который новый клиент шлёт «вслепую». */
export function isDiscoverRequest(message: unknown): boolean {
	const single = Array.isArray(message) ? message[0] : message;
	return !!single && typeof single === 'object' && (single as { method?: unknown }).method === MCP_DISCOVER_METHOD;
}

/**
 * Можно ли обслужить сообщение без сессии.
 *
 * Два случая: запрос по новой ревизии (версия в `_meta`) и `server/discover`, которым клиент как раз
 * и выясняет, с кем говорит. Всё остальное без сессии — старый клиент, забывший рукопожатие.
 */
export function isStatelessMessage(message: unknown): boolean {
	return statelessProtocolVersionOf(message) !== undefined || isDiscoverRequest(message);
}
