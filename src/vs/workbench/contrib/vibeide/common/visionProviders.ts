/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Какие провайдеры читают картинки сами: общие предикаты для шлюза локального OCR (`imageQAIntegration`) и для проверок
 * зрения в окне (`visionModelHelper`).
 *
 * Anthropic, OpenAI, Gemini и Pollinations — провайдеры из файлов набора, а не встроенные, поэтому узнаются по вендору (id в любом
 * написании), а подключённость читается иначе: у встроенного — введённый ключ, у файлового — подтверждённый доступ
 * (`_didFillInProviderSettings`): ключ может прийти из `.vibe/.env` или переменной окружения и в карточку не попадает.
 */

import { vendorOfProviderId, ProviderVendor } from './providerVendor.js';
import { isBuiltinProviderId, ProviderId, VibeideStatefulModelInfo } from './vibeideSettingsTypes.js';

/** Вендоры, чьи модели чата принимают картинки без оговорок по модели. */
const NATIVE_VISION_VENDORS: ReadonlySet<ProviderVendor> = new Set<ProviderVendor>(['anthropic', 'openAI', 'gemini', 'pollinations']);

/** Встроенные провайдеры, у которых зрение зависит от модели, а не от провайдера: решает каталог или имя модели. */
const BUILTIN_VISION_AGGREGATORS: readonly ProviderId[] = ['openRouter', 'openCodeZen', 'liteLLM', 'minimax'];

export const isNativeVisionProvider = (providerId: ProviderId): boolean => {
	const vendor = vendorOfProviderId(providerId);
	return vendor !== undefined && NATIVE_VISION_VENDORS.has(vendor);
};

/** Агрегаторы и «Совместимо с OpenAI API»: зрение у каждой модели своё. */
export const isVisionAggregatorProvider = (providerId: ProviderId): boolean =>
	BUILTIN_VISION_AGGREGATORS.includes(providerId) || vendorOfProviderId(providerId) === 'openAICompatible';

/** Минимум для проверки: поля настроек провайдера, которые читаются здесь. */
export interface VisionProviderSettings {
	readonly apiKey?: string;
	readonly _didFillInProviderSettings?: boolean;
	readonly models: readonly Pick<VibeideStatefulModelInfo, 'modelName' | 'isHidden'>[];
}

/** Длина ключа, короче которой введённое в карточку встроенного провайдера считается заглушкой. */
const MIN_REAL_KEY_LENGTH = 10;

/** Провайдер подключён: у встроенного введён ключ, у файлового сервис подтвердил доступ. */
export function isProviderConnected(providerId: ProviderId, settings: VisionProviderSettings | undefined): boolean {
	if (!settings) { return false; }
	return isBuiltinProviderId(providerId)
		? typeof settings.apiKey === 'string' && settings.apiKey.length > MIN_REAL_KEY_LENGTH
		: settings._didFillInProviderSettings === true;
}
