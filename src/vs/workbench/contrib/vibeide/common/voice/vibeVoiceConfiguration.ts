/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — `vibeide.voice.*` settings. Registered on module load; the module is
 * imported (side effect) from `browser/vibeide.contribution.ts` so the keys exist in the
 * Settings UI regardless of whether the desktop STT services are running.
 *
 * The dictation LANGUAGE deliberately has no own key: the upstream
 * `accessibility.voice.speechLanguage` (appears once a speech provider is registered,
 * `auto` → display language) drives editor/terminal dictation and our chat facade alike.
 */

import { localize } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { VoiceEnglishBatchTier, VOICE_ENGLISH_BATCH_TIERS, VOICE_ENGLISH_BATCH_TIER_DEFAULT } from './vibeVoiceModels.js';

export const VOICE_ENABLED_KEY = 'vibeide.voice.enabled';
export const VOICE_MODELS_PATH_KEY = 'vibeide.voice.modelsPath';
export const VOICE_THREADS_KEY = 'vibeide.voice.threads';
export const VOICE_ENDPOINT_SILENCE_KEY = 'vibeide.voice.endpointSilenceMs';
export const VOICE_KEEP_ALIVE_KEY = 'vibeide.voice.keepAliveSec';
export const VOICE_ENGLISH_BATCH_MODEL_KEY = 'vibeide.voice.englishBatchModel';

/** Normalize the raw `englishBatchModel` setting to a known tier (default `small`). */
export function resolveVoiceEnglishBatchTier(configured: unknown): VoiceEnglishBatchTier {
	return VOICE_ENGLISH_BATCH_TIERS.includes(configured as VoiceEnglishBatchTier)
		? configured as VoiceEnglishBatchTier
		: VOICE_ENGLISH_BATCH_TIER_DEFAULT;
}

export const VOICE_ENDPOINT_SILENCE_DEFAULT_MS = 800;
export const VOICE_KEEP_ALIVE_DEFAULT_SEC = 300;

const THREADS_MIN = 1;
const THREADS_MAX = 8;
const ENDPOINT_SILENCE_MIN_MS = 300;
const ENDPOINT_SILENCE_MAX_MS = 5000;
const KEEP_ALIVE_MIN_SEC = 0;
const KEEP_ALIVE_MAX_SEC = 3600;

/** Effective inference thread count: `0` (auto) → half the cores, clamped to 1..8. */
export function resolveVoiceThreads(configured: number, cpuCount: number): number {
	const wanted = configured > 0 ? configured : Math.floor(cpuCount / 2);
	return Math.min(THREADS_MAX, Math.max(THREADS_MIN, wanted));
}

export function clampVoiceEndpointSilenceMs(configured: number): number {
	if (!Number.isFinite(configured)) {
		return VOICE_ENDPOINT_SILENCE_DEFAULT_MS;
	}
	return Math.min(ENDPOINT_SILENCE_MAX_MS, Math.max(ENDPOINT_SILENCE_MIN_MS, configured));
}

export function clampVoiceKeepAliveSec(configured: number): number {
	if (!Number.isFinite(configured)) {
		return VOICE_KEEP_ALIVE_DEFAULT_SEC;
	}
	return Math.min(KEEP_ALIVE_MAX_SEC, Math.max(KEEP_ALIVE_MIN_SEC, configured));
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		[VOICE_ENABLED_KEY]: {
			type: 'boolean',
			default: true,
			description: localize('vibeide.voice.enabled', 'Голосовой ввод (диктовка): локальное распознавание речи без сети — модели работают на этом компьютере. Выключение убирает провайдер речи и все точки входа (кнопка в чате, диктовка в редакторе и терминале).'),
		},
		[VOICE_MODELS_PATH_KEY]: {
			type: 'string',
			default: '',
			description: localize('vibeide.voice.modelsPath', 'Каталог с моделями распознавания речи. Пустая строка — стандартное расположение в данных пользователя. Для офлайн-переноса: скачайте модели на машине с интернетом и укажите путь к скопированному каталогу здесь.'),
		},
		[VOICE_THREADS_KEY]: {
			type: 'number',
			default: 0,
			minimum: 0,
			maximum: THREADS_MAX,
			description: localize('vibeide.voice.threads', 'Потоки CPU для распознавания речи. 0 — автоматически (половина ядер, не более {0}).', THREADS_MAX),
		},
		[VOICE_ENDPOINT_SILENCE_KEY]: {
			type: 'number',
			default: VOICE_ENDPOINT_SILENCE_DEFAULT_MS,
			minimum: ENDPOINT_SILENCE_MIN_MS,
			maximum: ENDPOINT_SILENCE_MAX_MS,
			description: localize('vibeide.voice.endpointSilenceMs', 'Пауза в речи (мс), после которой фраза считается законченной и фиксируется финальный текст.'),
		},
		[VOICE_KEEP_ALIVE_KEY]: {
			type: 'number',
			default: VOICE_KEEP_ALIVE_DEFAULT_SEC,
			minimum: KEEP_ALIVE_MIN_SEC,
			maximum: KEEP_ALIVE_MAX_SEC,
			description: localize('vibeide.voice.keepAliveSec', 'Сколько секунд держать процесс распознавания с загруженными моделями после окончания диктовки (быстрый повторный старт ценой памяти). 0 — выгружать сразу.'),
		},
		[VOICE_ENGLISH_BATCH_MODEL_KEY]: {
			type: 'string',
			enum: [...VOICE_ENGLISH_BATCH_TIERS],
			enumDescriptions: [
				localize('vibeide.voice.englishBatchModel.small', 'Небольшая модель (~19 МБ загрузки) — быстрее и легче, для английского подкаста обычно достаточно.'),
				localize('vibeide.voice.englishBatchModel.medium', 'Модель побольше (~38 МБ загрузки) — точнее ценой скорости и памяти.'),
			],
			default: VOICE_ENGLISH_BATCH_TIER_DEFAULT,
			description: localize('vibeide.voice.englishBatchModel', 'Какую модель распознавания использовать для разбора АНГЛИЙСКОГО аудио командой /watch без субтитров. На русский не влияет (там используется GigaAM).'),
		},
	},
});
