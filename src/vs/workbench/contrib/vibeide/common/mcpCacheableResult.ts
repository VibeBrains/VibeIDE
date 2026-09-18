/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Срок годности списка, объявленный самим MCP-сервером.
 *
 * Ревизия спеки 2026-07-28 ввела `CacheableResult` (SEP-2549): результаты `tools/list`,
 * `resources/list`, `prompts/list` и `resources/read` несут в `_meta` поля `ttlMs` и `cacheScope`.
 *
 * WHY это ценно именно у нас: мы список инструментов не опрашиваем вовсе — читаем один раз при
 * подключении и держим до ручного обновления. Экономить нечего, а вот протухать есть чему: сервер,
 * добавивший инструмент, для нас его не добавил, пока человек не нажмёт «обновить». Срок годности —
 * это ровно то разрешение перечитать, которого у нас не было.
 *
 * Поля необязательные и приходят только от новых серверов, поэтому их отсутствие значит «сервер
 * ничего не обещал», а не «ноль».
 */

/** Как долго список считается свежим и на что распространяется. */
export interface McpCacheableMeta {
	/** Срок жизни в миллисекундах; всегда больше нуля и конечен. */
	readonly ttlMs: number;
	/** Область кэша, как её назвал сервер (`session`, `global`, своё слово). Пусто — не сказал. */
	readonly cacheScope?: string;
}

const TTL_KEY = 'io.modelcontextprotocol/ttlMs';
const SCOPE_KEY = 'io.modelcontextprotocol/cacheScope';

/**
 * Прочитать срок годности из результата запроса, или `undefined`, если сервер его не объявил.
 *
 * Разбор намеренно строгий: `ttlMs` строкой, нулём или бесконечностью — это не срок, а мусор, и
 * перечитывать по нему список значит опрашивать сервер по опечатке в его же ответе.
 */
export function parseCacheableMeta(result: unknown): McpCacheableMeta | undefined {
	const meta = (result as { _meta?: unknown } | undefined)?._meta;
	if (!meta || typeof meta !== 'object') {
		return undefined;
	}
	const bag = meta as Record<string, unknown>;
	const ttl = bag[TTL_KEY];
	if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
		return undefined;
	}
	const scope = bag[SCOPE_KEY];
	return {
		ttlMs: ttl,
		...(typeof scope === 'string' && scope.trim() ? { cacheScope: scope.trim() } : {}),
	};
}

/** Ниже этого порога срок не принимается буквально: сервер с `ttlMs: 1` превратил бы нас в опрос. */
export const MCP_MIN_REFRESH_MS = 30_000;

/** Через сколько перечитывать список: срок сервера, но не чаще порога. */
export function refreshDelayMs(meta: McpCacheableMeta): number {
	return Math.max(MCP_MIN_REFRESH_MS, meta.ttlMs);
}
