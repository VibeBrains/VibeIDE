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

/** Настройка с таблицей имён — сильнейший слой поверх блоков `routes` файлов провайдеров. */
export const MODEL_ROUTES_SETTING = 'vibeide.model.routes';

/** Префикс, которым ссылка на ключ отличается от имени модели: `@fast` против `fast`. */
const ROUTE_PREFIX = '@';

/**
 * Таблица ключей: имя → ссылка на модель (`provider/model` или просто `model`).
 * `null` — имя объявлено и ЗАПРЕЩЕНО: нижний слой не может его вернуть.
 */
export type ModelRoutes = Readonly<Record<string, string | null>>;

/** Имя без знака `@` и пробелов по краям. */
function nameOf(key: string): string {
	return key.trim().replace(new RegExp(`^${ROUTE_PREFIX}`), '').trim();
}

/**
 * Привести таблицу из настройки или файла к рабочему виду.
 *
 * Пустые имена и пустые строки выбрасываются: ключ без модели — это не «модель по умолчанию», а
 * недописанная строка, и разворачивать его во что-либо значило бы угадывать. `null` остаётся:
 * это запрет, а не пустота.
 */
export function normalizeModelRoutes(raw: unknown): ModelRoutes {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}
	const routes: Record<string, string | null> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const name = nameOf(key);
		if (!name) {
			continue;
		}
		if (value === null) {
			routes[name] = null;
			continue;
		}
		const target = typeof value === 'string' ? value.trim() : '';
		if (target) {
			routes[name] = target;
		}
	}
	return routes;
}

/**
 * Сложить слои, первый — самый слабый: позднее имя перекрывает раннее, объявленный `null` переживает слияние.
 *
 * Порядок слоёв — общий контракт с VibeIDEA: глобальные `providers/*`, глобальный `providers.json`,
 * проектные `providers/*`, проектный `providers.json`; у нас сверху ещё настройка `vibeide.model.routes`.
 */
export function mergeModelRoutes(layers: readonly ModelRoutes[]): ModelRoutes {
	const merged: Record<string, string | null> = {};
	for (const layer of layers) {
		for (const [name, target] of Object.entries(normalizeModelRoutes(layer))) {
			merged[name] = target;
		}
	}
	return merged;
}

/** Имя ключа, если ссылка написана ключом; иначе `undefined` — это обычное имя модели. */
export function routeKeyOf(reference: string | undefined): string | undefined {
	if (typeof reference !== 'string') {
		return undefined;
	}
	const text = reference.trim();
	return text.startsWith(ROUTE_PREFIX) && text.length > ROUTE_PREFIX.length ? text.slice(ROUTE_PREFIX.length).trim() : undefined;
}

/** Чем закончилось разворачивание ссылки. */
export type RouteResolution =
	| { readonly kind: 'model'; readonly reference: string }
	| { readonly kind: 'unknown-key'; readonly key: string; readonly known: readonly string[] }
	| { readonly kind: 'disabled'; readonly key: string };

/**
 * Развернуть ссылку: ключ — по таблице, обычное имя — как есть.
 *
 * Неизвестный и запрещённый ключ возвращаются отдельными исходами, а не подставляются молча:
 * подставить здесь что-нибудь — значит выполнить работу не той моделью и не сказать об этом.
 */
export function resolveModelReference(reference: string, routes: ModelRoutes): RouteResolution {
	const key = routeKeyOf(reference);
	if (key === undefined) {
		return { kind: 'model', reference: reference.trim() };
	}
	if (!Object.hasOwn(routes, key)) {
		return { kind: 'unknown-key', key, known: Object.keys(routes).sort() };
	}
	const target = routes[key];
	return target === null ? { kind: 'disabled', key } : { kind: 'model', reference: target };
}
