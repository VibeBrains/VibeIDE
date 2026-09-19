/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Пропуск к шлюзу MCP: локальный токен вместо идентификатора сессии в адресе.
 *
 * WHY: до ревизии 2026-07-28 пропуском de facto служил `routeId` в пути — 122 бита, которые не
 * угадываются. Ревизия упразднила протокольные сессии, и клиент новой ревизии ходит без них; то
 * есть секрет в пути перестал быть механизмом, на который можно опираться. Сокет при этом слушает
 * только петлю, но «только петля» — это про сеть, а не про машину: любой процесс пользователя
 * может вызвать инструмент MCP и получить побочные эффекты на его же файлах.
 *
 * Токен кладётся в `~/.vibe/mcp-gateway.token` с правами только владельцу. Клиент на этой машине
 * читает файл и шлёт `Authorization: Bearer <токен>`; ничего настраивать вручную не нужно, и
 * работает это офлайн.
 *
 * Секрет в URL сознательно не используем: адрес уезжает в логи, историю команд и `Referer`, а
 * заголовок — нет.
 */

/** Заголовок, которым клиент предъявляет токен. */
export const MCP_GATEWAY_AUTH_HEADER = 'authorization';

/** Имя файла с токеном внутри `~/.vibe`. */
export const MCP_GATEWAY_TOKEN_FILE = 'mcp-gateway.token';

/** Токен из заголовка `Authorization: Bearer …`, или `undefined`, если его там нет. */
export function bearerTokenOf(header: string | string[] | undefined): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== 'string') {
		return undefined;
	}
	const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
	return match ? match[1] : undefined;
}

/**
 * Совпадает ли предъявленный токен с ожидаемым.
 *
 * Сравнение идёт по всей длине, а не до первого различия: обычное `===` на строках отвечает тем
 * быстрее, чем раньше расходятся байты, и по этому времени токен подбирается посимвольно. Здесь
 * это стоит десятка операций, а там — всей защиты.
 */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
	if (!expected || presented === undefined || presented.length !== expected.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < expected.length; i++) {
		diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
	}
	return diff === 0;
}

/** Ответ клиенту без пропуска: что произошло и где взять токен. */
export function unauthorizedBody(tokenPath: string): string {
	return JSON.stringify({
		error: 'Unauthorized',
		error_description: `MCP gateway requires a local token. Read it from ${tokenPath} and send it as "Authorization: Bearer <token>".`,
	});
}
