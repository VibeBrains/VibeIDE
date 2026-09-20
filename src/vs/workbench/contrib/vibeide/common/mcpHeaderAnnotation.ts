/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Аннотация `x-mcp-header` в описании инструмента: значение параметра уезжает в HTTP-заголовок.
 *
 * Сервер вправе пометить параметр, и клиент на Streamable HTTP обязан отправить его значение
 * заголовком `Mcp-Param-{имя}` — чтобы посредники (балансировщики, прокси) могли маршрутизировать
 * запрос, не разбирая тело.
 *
 * WHY этот модуль существует, хотя сами заголовки мы не отправляем: ревизия 2026-07-28 требует от
 * клиента ОТВЕРГАТЬ описание инструмента с негодной аннотацией — исключать такой инструмент из
 * результата `tools/list` и записывать причину. Требование не про отправку, а про доверие: имя
 * заголовка приходит от сервера, попадает в HTTP и потому обязано быть именем заголовка, а не
 * произвольной строкой. Перевод строки в таком значении — это внедрение чужого заголовка.
 *
 * Остальные инструменты сервера при этом продолжают работать: одно битое описание не должно лишать
 * пользователя всего списка.
 */

/** Токен имени HTTP-поля (RFC 9110 §5.1): буквы, цифры и перечисленные знаки, без пробелов. */
const FIELD_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Типы параметров, значение которых можно отдать заголовком. `number` спека исключает. */
const HEADER_TYPES = new Set(['string', 'integer', 'boolean']);

/** Безопасный диапазон целых: значение крупнее не переживёт JSON-разбор без потерь. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** Почему описание инструмента отвергнуто. Пусто — описание годное. */
export function rejectToolReason(tool: unknown): string | undefined {
	const schema = (tool as { inputSchema?: unknown } | undefined)?.inputSchema;
	const properties = (schema as { properties?: unknown } | undefined)?.properties;
	if (!properties || typeof properties !== 'object') {
		return undefined;
	}
	const seen = new Set<string>();
	for (const [property, raw] of Object.entries(properties as Record<string, unknown>)) {
		const definition = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
		const header = definition?.['x-mcp-header'];
		if (header === undefined) {
			continue;
		}
		if (typeof header !== 'string' || header.length === 0) {
			return `параметр «${property}»: имя заголовка пустое или не строка`;
		}
		if (!FIELD_NAME.test(header)) {
			return `параметр «${property}»: «${header}» не является именем HTTP-заголовка`;
		}
		const key = header.toLowerCase();
		if (seen.has(key)) {
			return `параметр «${property}»: имя заголовка «${header}» уже занято другим параметром`;
		}
		seen.add(key);
		const type = definition?.['type'];
		if (typeof type !== 'string' || !HEADER_TYPES.has(type)) {
			return `параметр «${property}»: заголовком можно отдать только строку, целое или логическое, а объявлено «${String(type)}»`;
		}
		const maximum = definition?.['maximum'];
		if (type === 'integer' && typeof maximum === 'number' && Math.abs(maximum) > MAX_SAFE) {
			return `параметр «${property}»: предел ${maximum} вне безопасного диапазона целых`;
		}
	}
	return undefined;
}

/** Инструмент, отвергнутый вместе с причиной — для журнала. */
export interface RejectedTool {
	readonly name: string;
	readonly reason: string;
}

/**
 * Отсеять инструменты с негодной аннотацией.
 *
 * Возвращает оставшиеся и список отвергнутых: причина нужна в журнале, иначе исчезнувший инструмент
 * выглядит как отсутствующий у сервера.
 */
export function filterToolsWithValidHeaders<T extends { name?: unknown }>(tools: readonly T[]): { readonly tools: T[]; readonly rejected: RejectedTool[] } {
	const kept: T[] = [];
	const rejected: RejectedTool[] = [];
	for (const tool of tools) {
		const reason = rejectToolReason(tool);
		if (reason) {
			rejected.push({ name: typeof tool.name === 'string' ? tool.name : '(без имени)', reason });
			continue;
		}
		kept.push(tool);
	}
	return { tools: kept, rejected };
}
