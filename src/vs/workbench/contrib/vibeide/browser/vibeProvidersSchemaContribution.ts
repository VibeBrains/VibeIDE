/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Editing experience for `.vibe/providers.json` (user-defined LLM providers):
 *   1) JSON Schema → IntelliSense (field autocomplete, value enums, hovers, validation).
 *   2) `files.associations` → the file opens as `jsonc`, so `//` comments are valid + highlighted.
 *
 * Schema content is registered with the JSON contribution registry; the file→schema and
 * file→language associations are shipped as configuration DEFAULTS (an explicit user setting still
 * wins). The schema mirrors `common/vibeProvidersFile.ts` — keep them in sync.
 */

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IJSONSchema } from '../../../../base/common/jsonSchema.js';
import * as jsonContributionRegistry from '../../../../platform/jsonschemas/common/jsonContributionRegistry.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { providerNames } from '../common/vibeideSettingsTypes.js';

const SCHEMA_ID = 'vscode://schemas/vibeide-providers';
const FILE_GLOB = '**/.vibe/providers.json';

/** Built-in provider ids surfaced as autocomplete proposals for `id` / `extends` / `apiKeyRef`.
 *  `examples` (not `enum`) so suggestions appear WITHOUT forbidding brand-new/custom ids. */
const BUILTIN_PROVIDER_IDS: string[] = [...providerNames];

const modelSchema: IJSONSchema = {
	type: 'object',
	required: ['id'],
	additionalProperties: false,
	properties: {
		id: { type: 'string', description: 'Идентификатор модели, отправляемый в API.' },
		name: { type: 'string', description: 'Отображаемое имя.' },
		active: { type: 'boolean', default: true, description: 'false — скрыть модель из выбора.' },
		default: { type: 'boolean', description: 'Пометить как модель по умолчанию (авто-выбор).' },
		pinned: { type: 'boolean', description: 'Показывать вверху списка.' },
		contextWindow: { type: 'number', description: 'Размер контекстного окна (входные токены).' },
		maxOutputTokens: { type: 'number', description: 'Резерв на вывод (токены).' },
		toolFormat: { enum: ['openai', 'anthropic', 'gemini', 'none'], description: 'Формат tool-calling.' },
		vision: { type: 'boolean', description: 'Поддержка изображений.' },
		systemMessage: { enum: ['system', 'developer', 'separated', false], description: 'Как доставляется system-сообщение.' },
		fim: { type: 'boolean', description: 'Поддержка fill-in-the-middle (автодополнение).' },
		reasoning: {
			description: 'false — без reasoning; объект — параметры размышления.',
			oneOf: [
				{ type: 'boolean', enum: [false] },
				{
					type: 'object', additionalProperties: false, properties: {
						canTurnOff: { type: 'boolean' },
						field: { type: 'string', description: 'Поле payload с тумблером/усилием (thinking, reasoning_effort).' },
						effort: { type: 'array', items: { type: 'string' }, description: 'Допустимые значения усилия, напр. ["low","high"].' },
						thinkTags: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2, description: 'Пара think-тегов, напр. ["<think>","</think>"].' },
					},
				},
			],
		},
		cost: {
			type: 'object', additionalProperties: false, description: '$/1M токенов — для индикатора бюджета.',
			properties: { input: { type: 'number' }, output: { type: 'number' }, cacheRead: { type: 'number' }, cacheWrite: { type: 'number' } },
		},
		temperature: { type: 'number' },
		topP: { type: 'number' },
		topK: { type: 'number' },
		extraBody: { type: 'object', description: 'Доп. поля в тело запроса (квирки провайдера/модели).' },
		note: { type: 'string' },
	},
};

const providerSchema: IJSONSchema = {
	type: 'object',
	required: ['id'],
	additionalProperties: false,
	properties: {
		id: { type: 'string', examples: BUILTIN_PROVIDER_IDS, description: 'Уникальный ключ. Совпадение со встроенным id — патч встроенного; новый id — новый провайдер. Подсказки в списке — id встроенных.' },
		extends: { type: 'string', examples: BUILTIN_PROVIDER_IDS, description: 'Унаследовать все поля от другого провайдера (built-in или из файла), затем переопределить ниже.' },
		name: { type: 'string', description: 'Отображаемое имя.' },
		active: { type: 'boolean', default: true, description: 'false — выключить провайдера и все его модели.' },
		order: { type: 'number', description: 'Порядок среди ВАШИХ провайдеров (меньше = выше); они показываются НАД встроенными в выборе модели. Без значения — в конец вашего блока, по имени. Встроенные между собой не двигаются.' },
		tags: { type: 'array', items: { type: 'string' } },
		note: { type: 'string' },
		protocol: { enum: ['openai', 'anthropic', 'gemini'], default: 'openai', description: 'Протокол транспорта. В Фазе 1 надёжно работает openai.' },
		baseURL: { type: 'string', description: 'Базовый URL API.' },
		auth: {
			description: 'Авторизация. "bearer" или объект.',
			oneOf: [
				{ type: 'string', enum: ['bearer'] },
				{ type: 'object', required: ['type'], additionalProperties: false, properties: { type: { enum: ['bearer', 'header', 'query'] }, name: { type: 'string', description: 'Имя заголовка/параметра для header/query.' } } },
			],
		},
		apiKeyEnv: { type: 'string', description: 'Ключ из переменной окружения (в файле НЕ хранится).' },
		apiKeyRef: { type: 'string', examples: BUILTIN_PROVIDER_IDS, description: 'Ключ из защищённых настроек VibeIDE (по id провайдера).' },
		headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Статические HTTP-заголовки.' },
		query: { type: 'object', additionalProperties: { type: 'string' }, description: 'Статические query-параметры.' },
		timeoutMs: { type: 'number', description: 'Таймаут запроса (мс). Агрегаторам нужно больше.' },
		docsUrl: { type: 'string' },
		apiKeyUrl: { type: 'string' },
		models: {
			type: 'object', additionalProperties: false,
			properties: {
				fetch: { description: 'true — авто-список из <baseURL>/models; строка — URL; false — только static.', oneOf: [{ type: 'boolean' }, { type: 'string' }] },
				static: { type: 'array', items: modelSchema },
			},
		},
	},
};

const providersFileSchema: IJSONSchema = {
	$id: SCHEMA_ID,
	type: 'object',
	additionalProperties: false,
	description: 'VibeIDE — определения LLM-провайдеров и моделей (.vibe/providers.json).',
	properties: {
		version: { type: 'number', default: 1, description: 'Версия схемы.' },
		providers: { type: 'array', description: 'Список провайдеров.', items: providerSchema },
	},
	required: ['providers'],
};

Registry.as<jsonContributionRegistry.IJSONContributionRegistry>(jsonContributionRegistry.Extensions.JSONContribution)
	.registerSchema(SCHEMA_ID, providersFileSchema);

// Ship the file→schema (IntelliSense) and file→jsonc (comments + highlighting) associations as
// defaults — an explicit user setting still wins.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([
	{
		overrides: {
			'files.associations': { [FILE_GLOB]: 'jsonc' },
			'json.schemas': [{ fileMatch: [FILE_GLOB], url: SCHEMA_ID }],
		},
	},
]);
