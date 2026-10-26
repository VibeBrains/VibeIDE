/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Вендор, чьи модели обслуживает провайдер.
 *
 * Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Vertex, Azure, Bedrock, Pollinations и «Совместимо с OpenAI API» когда-то были
 * встроенными провайдерами, а теперь приходят файлами общего набора (`.vibe/providers/*.jsonc`). Таблицы возможностей моделей
 * этих вендоров (профили Claude, GPT, Gemini и так далее) остались в продукте: они привязаны к вендору, а не к тому, встроен он
 * или пришёл из файла. Этот модуль отвечает на один вопрос: «чей это провайдер» — по id, в любом написании, или по адресу.
 *
 * Идентификатор в файле набора пишется строчными с дефисами (`openai`, `google-gemini`), прежний встроенный — camelCase
 * (`openAI`, `googleVertex`), и оба читаются как один вендор: сравнение не различает регистр и разделители.
 *
 * Чистый модуль без зависимостей: его читают оба процесса и тесты.
 */

/** Вендоры, чьи таблицы возможностей моделей остались в продукте. Имена — прежние id встроенных провайдеров. */
export const PROVIDER_VENDORS = [
	'anthropic', 'openAI', 'gemini', 'xAI', 'mistral', 'groq',
	'googleVertex', 'microsoftAzure', 'awsBedrock', 'pollinations', 'openAICompatible',
] as const;

export type ProviderVendor = typeof PROVIDER_VENDORS[number];

/**
 * Id провайдера в файле набора (`providers/<id>.jsonc`) для каждого вендора.
 * Единственный список соответствия «прежний встроенный id → файл набора»: перенос настроек, порядок «Авто»,
 * знакомство и список комплектных файлов берут его отсюда.
 */
export const CONFIG_ID_OF_VENDOR: Readonly<Record<ProviderVendor, string>> = {
	anthropic: 'anthropic',
	openAI: 'openai',
	gemini: 'google-gemini',
	xAI: 'xai',
	mistral: 'mistral',
	groq: 'groq',
	googleVertex: 'google-vertex',
	microsoftAzure: 'azure-openai',
	awsBedrock: 'aws-bedrock',
	pollinations: 'pollinations',
	openAICompatible: 'openai-compatible',
};

/** Сравнение id не различает регистр и разделители: `openAI`, `openai`, `open-ai` — один и тот же. */
const normalizeId = (id: string): string => id.toLowerCase().replace(/[-_]/g, '');

/** Нормализованное написание → вендор: и прежний встроенный id, и id файла набора, и короткое `gemini`. */
const VENDOR_BY_NORMALIZED_ID: ReadonlyMap<string, ProviderVendor> = new Map<string, ProviderVendor>([
	...PROVIDER_VENDORS.map(vendor => [normalizeId(vendor), vendor] as const),
	...PROVIDER_VENDORS.map(vendor => [normalizeId(CONFIG_ID_OF_VENDOR[vendor]), vendor] as const),
]);

/** Адрес вендора → вендор: провайдер с другим id, но на родном адресе вендора, получает его таблицы моделей. */
const VENDOR_BY_HOST: ReadonlyMap<string, ProviderVendor> = new Map<string, ProviderVendor>([
	['api.anthropic.com', 'anthropic'],
	['api.openai.com', 'openAI'],
	['generativelanguage.googleapis.com', 'gemini'],
	['api.x.ai', 'xAI'],
	['api.mistral.ai', 'mistral'],
	['api.groq.com', 'groq'],
	['gen.pollinations.ai', 'pollinations'],
]);

/** Вендор по id провайдера в любом написании; `undefined` — id не принадлежит ни одному из них. */
export function vendorOfProviderId(providerId: string): ProviderVendor | undefined {
	return VENDOR_BY_NORMALIZED_ID.get(normalizeId(providerId));
}

/** Вендор по адресу провайдера; `undefined` — адрес не родной ни для одного из них. */
export function vendorOfBaseURL(baseURL: string | undefined): ProviderVendor | undefined {
	if (!baseURL) { return undefined; }
	try {
		return VENDOR_BY_HOST.get(new URL(baseURL).hostname.toLowerCase());
	} catch {
		return undefined;
	}
}

/** Вендор провайдера: по id, а если id чужой — по адресу. */
export function vendorOfProvider(providerId: string, baseURL?: string): ProviderVendor | undefined {
	return vendorOfProviderId(providerId) ?? vendorOfBaseURL(baseURL);
}

/**
 * Строчное имя вендора для эвристик по имени провайдера (`openai`, `anthropic`, `gemini`), а для чужого id — сам id строчными.
 * Так `google-gemini` и `gemini` читаются одинаково, а `kimi` остаётся `kimi`.
 */
export function providerVendorKey(providerId: string): string {
	return (vendorOfProviderId(providerId) ?? providerId).toLowerCase();
}

/**
 * Прежний id встроенного провайдера → id его файла в наборе (`openAI` → `openai`, `gemini` → `google-gemini`).
 * Настройки и файлы пользователей писали id в прежнем написании: ссылка на модель `openAI/gpt-5` в настройке или пайплайне
 * должна найти провайдера из файла. Только точные прежние написания; остальные id проходят как есть.
 */
export function canonicalProviderId(providerId: string): string {
	return (PROVIDER_VENDORS as readonly string[]).includes(providerId) ? CONFIG_ID_OF_VENDOR[providerId as ProviderVendor] : providerId;
}
