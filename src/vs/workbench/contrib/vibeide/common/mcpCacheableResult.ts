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
 *
 * ГДЕ ОНИ ЛЕЖАТ: в КОРНЕ результата, рядом с `tools` и `nextCursor`, а не в `_meta`. Первая наша
 * попытка (18.09.2026) читала `_meta` — против настоящего сервера ревизии это давало «сервер ничего
 * не обещал» всегда, то есть перечитка была мёртвым кодом. Пример из спеки (`server/tools`):
 *   "nextCursor": "next-page-cursor", "ttlMs": 300000, "cacheScope": "public"
 */

/**
 * Кому можно отдавать закэшированный ответ.
 *
 * `public` — ответ одинаков для всех, его вправе держать и разделяемый посредник. `private` — ответ
 * зависит от того, кто спросил, и в общем кэше ему не место. Своих значений спека не допускает.
 */
export type McpCacheScope = 'public' | 'private';

/** Как долго список считается свежим и на что распространяется. */
export interface McpCacheableMeta {
	/** Срок жизни в миллисекундах; всегда больше нуля и конечен. */
	readonly ttlMs: number;
	/** Область кэша, если сервер назвал её одним из двух допустимых слов. */
	readonly cacheScope?: McpCacheScope;
}

/**
 * Прочитать срок годности из результата запроса, или `undefined`, если сервер его не объявил.
 *
 * Разбор намеренно строгий: `ttlMs` строкой, нулём или бесконечностью — это не срок, а мусор, и
 * перечитывать по нему список значит опрашивать сервер по опечатке в его же ответе.
 */
export function parseCacheableMeta(result: unknown): McpCacheableMeta | undefined {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	const bag = result as Record<string, unknown>;
	const ttl = bag['ttlMs'];
	if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
		return undefined;
	}
	const scope = bag['cacheScope'];
	return {
		ttlMs: ttl,
		...(scope === 'public' || scope === 'private' ? { cacheScope: scope } : {}),
	};
}

/** Ниже этого порога срок не принимается буквально: сервер с `ttlMs: 1` превратил бы нас в опрос. */
export const MCP_MIN_REFRESH_MS = 30_000;

/** Через сколько перечитывать список: срок сервера, но не чаще порога. */
export function refreshDelayMs(meta: McpCacheableMeta): number {
	return Math.max(MCP_MIN_REFRESH_MS, meta.ttlMs);
}
