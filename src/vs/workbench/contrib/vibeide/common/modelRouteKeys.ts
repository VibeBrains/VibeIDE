/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Логические ключи маршрутов: `@fast`, `@smart`, `@review` вместо конкретной модели.
 *
 * WHY: одна и та же модель называется в трёх местах — в правилах «путь → модель», в шагах пайплайна
 * (`model`, `escalateTo`, `reviewWith`) и в наших собственных привычках. Вендор поднимает цену или
 * снимает модель — и правки нужны во всех трёх, причём молча разъезжаются они по одной.
 *
 * Ключ — это уровень косвенности и ничего больше: `@fast` разворачивается в `provider/model` по
 * таблице `vibeide.model.routes`. Новой сущности в маршрутизации не появляется, появляется имя.
 *
 * Идея из AIP-57 (черновик, agentproto): там пакет маршрутов обязан быть полным по своему
 * пространству ключей. У нас полноты нет намеренно — ключ, которого в таблице не оказалось,
 * означает «имени такого нет», и вызывающая сторона обязана сказать об этом, а не подставить
 * что-нибудь похожее.
 */

/** Префикс, которым ссылка на ключ отличается от имени модели: `@fast` против `fast`. */
const ROUTE_PREFIX = '@';

/** Таблица ключей: имя → ссылка на модель (`provider/model` или просто `model`). */
export type ModelRoutes = Readonly<Record<string, string>>;

/**
 * Привести таблицу из настроек к рабочему виду.
 *
 * Пустые имена и значения выбрасываются: ключ без модели — это не «модель по умолчанию», а
 * недописанная строка, и разворачивать его во что-либо значило бы угадывать.
 */
export function normalizeModelRoutes(raw: unknown): ModelRoutes {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}
	const routes: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const name = key.trim().replace(new RegExp(`^${ROUTE_PREFIX}`), '');
		const target = typeof value === 'string' ? value.trim() : '';
		if (!name || !target) {
			continue;
		}
		routes[name] = target;
	}
	return routes;
}

/** Имя ключа, если ссылка написана ключом; иначе `undefined` — это обычное имя модели. */
export function routeKeyOf(reference: string | undefined): string | undefined {
	if (typeof reference !== 'string') {
		return undefined;
	}
	const text = reference.trim();
	return text.startsWith(ROUTE_PREFIX) && text.length > ROUTE_PREFIX.length ? text.slice(ROUTE_PREFIX.length) : undefined;
}

/** Чем закончилось разворачивание ссылки. */
export type RouteResolution =
	| { readonly kind: 'model'; readonly reference: string }
	| { readonly kind: 'unknown-key'; readonly key: string };

/**
 * Развернуть ссылку: ключ — по таблице, обычное имя — как есть.
 *
 * Неизвестный ключ возвращается отдельным исходом, а не подставляется молча: подставить здесь
 * что-нибудь — значит выполнить работу не той моделью и не сказать об этом.
 */
export function resolveModelReference(reference: string, routes: ModelRoutes): RouteResolution {
	const key = routeKeyOf(reference);
	if (key === undefined) {
		return { kind: 'model', reference: reference.trim() };
	}
	const target = routes[key];
	return target ? { kind: 'model', reference: target } : { kind: 'unknown-key', key };
}
