/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { defaultModelsOfProvider, defaultProviderSettings, ModelOverrides } from './modelCapabilities.js';
import { ToolApprovalType } from './toolsServiceTypes.js';
import { VibeideSettingsState } from './vibeideSettingsService.js';
import { CONFIG_ID_OF_VENDOR, ProviderVendor, vendorOfProviderId } from './providerVendor.js';


type UnionOfKeys<T> = T extends T ? keyof T : never;



export type ProviderName = keyof typeof defaultProviderSettings;
export const providerNames = Object.keys(defaultProviderSettings) as ProviderName[];

/**
 * Runtime identifier of ANY active provider — built-in (`ProviderName`) or config-defined
 * (`providers.json`, workspace or `~/.vibe`). Config providers are NOT second-class: model
 * selection, routing, auto-fallback, capabilities and settings APIs all speak `ProviderId` and
 * operate on the MERGED provider set. `ProviderName` survives only as the key type of the
 * compile-time built-in defaults tables; everything downstream must accept `ProviderId`.
 */
export type ProviderId = string;

/** Type guard: is this id a compile-time built-in? Narrows to `ProviderName` for typed table access. */
/**
 * Built-in ids are camelCase (`openAI`, `openCodeZen`), while the shared seed set in the VibeBrains
 * repo — the one both products install into `.vibe/` — writes them lowercase-with-dashes
 * (`openai`, `opencode-zen`), because VibeIDEA reads them that way. A user copying a seed file into
 * their `providers.json` would otherwise DEFINE a second provider next to the built-in instead of
 * patching it, and end up with two "OpenAI" entries in the model list.
 *
 * So matching ignores case and separators. This cannot merge two distinct built-ins: their
 * normalised forms are all unique (asserted by unit test).
 */
const normalizeProviderId = (id: string): string => id.toLowerCase().replace(/[-_]/g, '');

/** Built-in id under the canonical spelling, or `undefined` when the id defines a new provider. */
export const builtinProviderIdOf = (id: ProviderId): ProviderName | undefined => {
	const wanted = normalizeProviderId(id);
	return (providerNames as readonly ProviderName[]).find(name => normalizeProviderId(name) === wanted);
};

export const isBuiltinProviderId = (id: ProviderId): id is ProviderName => builtinProviderIdOf(id) !== undefined;

/**
 * Слоты ключа, которые общий набор называет не по id встроенного провайдера.
 * Набор пишут оба продукта; у VibeIDEA ключ OpenCode один на Go и Zen и живёт в слоте `opencode`.
 * У нас Go — провайдер из файла, а ключ Zen — настройка встроенного `openCodeZen`: на неё и указывает `opencode`.
 */
const API_KEY_REF_ALIASES: Readonly<Record<string, ProviderName>> = { opencode: 'openCodeZen' };

/**
 * Ключ в `settingsOfProvider`, на который указывает `apiKeyRef` провайдера из файла.
 * Встроенный id в любом написании (`opencode-zen`, `openCodeZen`) приводится к каноническому, общие слоты набора — по таблице,
 * остальное остаётся как есть (так, как и раньше, `apiKeyRef` мог указывать на id другого провайдера из файла).
 */
export const apiKeySlotOfRef = (apiKeyRef: string): string => builtinProviderIdOf(apiKeyRef) ?? API_KEY_REF_ALIASES[apiKeyRef.toLowerCase()] ?? apiKeyRef;

export const localProviderNames = ['ollama', 'vLLM', 'lmStudio'] satisfies ProviderName[]; // all local names
export const nonlocalProviderNames = providerNames.filter((name) => !(localProviderNames as string[]).includes(name)); // all non-local names

/**
 * Порядок кандидатов для «Авто»: пользователь выбрал `providerName: 'auto', modelName: 'auto'`, и мы идём по списку и берём
 * первого провайдера с заполненными настройками и хотя бы одной включённой моделью.
 * Голова — MiniMax, DeepSeek, OpenCode Zen: порядок задан владельцем и совпадает с порядком встроенных в настройках
 * (`defaultProviderSettings`). Дальше прежний порядок: облака флагманов (Anthropic, OpenAI, Gemini), другие облака
 * (xAI, Mistral, Groq), локальные (Ollama, vLLM, LM Studio), общие шлюзы («Совместимо с OpenAI API», OpenRouter, LiteLLM,
 * Pollinations).
 *
 * Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Pollinations и «Совместимо с OpenAI API» теперь провайдеры из файлов набора,
 * поэтому в списке стоят их id из файла (`CONFIG_ID_OF_VENDOR`), а не прежние id встроенных. Остальных файловых провайдеров
 * в списке нет: они идут перед ним (`autoFallbackProviderIds`).
 *
 * ЕДИНСТВЕННЫЙ источник порядка: его читают chatThreadService._findModelSelectionForId, vibeideSettingsService.resolveAutoModelSelection,
 * errorDetectionService и nlShellParserService. Новый провайдер = дописать id СЮДА (и в defaultProviderSettings, если он встроенный).
 */
export const autoModelFallbackProviderOrder: readonly ProviderId[] = [
	'minimax', 'deepseek', 'openCodeZen',
	CONFIG_ID_OF_VENDOR.anthropic, CONFIG_ID_OF_VENDOR.openAI, CONFIG_ID_OF_VENDOR.gemini,
	CONFIG_ID_OF_VENDOR.xAI, CONFIG_ID_OF_VENDOR.mistral, CONFIG_ID_OF_VENDOR.groq,
	'ollama', 'vLLM', 'lmStudio',
	CONFIG_ID_OF_VENDOR.openAICompatible, 'openRouter', 'liteLLM', CONFIG_ID_OF_VENDOR.pollinations,
];

/**
 * Кандидаты для «Авто» по всему слиянию провайдеров: файловые провайдеры (providers.json, каталог `providers/` — проектные
 * и из `~/.vibe`) СНАЧАЛА, потом выверенный порядок выше. Файловый провайдер, которого в выверенном порядке нет, — явная
 * настройка человека, она бьёт общий список предпочтений. Их относительный порядок — порядок вставки в состояние:
 * засев держит его по полю `order` файла, затем по имени. Тот, чей id уже стоит в выверенном порядке (Anthropic, OpenAI…),
 * идёт на своём месте в нём, а не вперёд: иначе MiniMax-первым перестал бы быть первым.
 * Любой обход «найди первого провайдера для авто-выбора» ОБЯЗАН идти через эту функцию, а не по голому списку выше.
 */
export const autoFallbackProviderIds = (settingsOfProvider: SettingsOfProvider): ProviderId[] => {
	const known = new Set(autoModelFallbackProviderOrder.map(id => id.toLowerCase()));
	const configIds = Object.keys(settingsOfProvider).filter(id => !isBuiltinProviderId(id) && !known.has(id.toLowerCase()));
	return [...configIds, ...autoModelFallbackProviderOrder];
};

/**
 * Каноническая переменная окружения ОС с ключом встроенного облачного провайдера
 *
 * Здесь только провайдеры, у которых единственная обязательная настройка — `apiKey`: ключа из окружения должно хватать, чтобы
 * провайдером можно было пользоваться, а `computeDidFillInProviderSettings` требует заполненными ВСЕ поля. Многополейные
 * (liteLLM, lmRoute — нужен `endpoint`) намеренно не перечислены. У OpenCode Zen общепринятого имени нет — его тоже нет.
 *
 * Ключи Anthropic, OpenAI, Gemini, xAI, Mistral и Groq из окружения читают их файлы набора через `apiKeyEnv`
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …): для файлового провайдера это штатный путь
 *
 * ИМЯ живёт здесь (общее), ЗНАЧЕНИЕ читается только в electron-main, где `process.env` надёжен: окно получает лишь признак наличия.
 */
export const apiKeyEnvVarOfProvider = {
	deepseek: 'DEEPSEEK_API_KEY',
	openRouter: 'OPENROUTER_API_KEY',
	minimax: 'MINIMAX_API_KEY',
} as const satisfies Partial<Record<ProviderName, string>>;

/** Providers that support picking their API key up from the OS environment. */
export const envCapableProviderNames = Object.keys(apiKeyEnvVarOfProvider) as (keyof typeof apiKeyEnvVarOfProvider)[];

/** Minimal view of an environment bag — `process.env` satisfies it, and tests can pass a literal. */
export type EnvVars = Readonly<Record<string, string | undefined>>;

/**
 * Fall back to the provider's canonical OS-env API key when Settings holds none.
 *
 * A key typed into the UI always wins, so an explicit setting can override the environment. The env
 * value is trimmed: shells and CI configs routinely leave a trailing newline, which would otherwise
 * surface much later as an invalid-header failure inside the HTTP client.
 *
 * Pure by design (env is a parameter, not `process.env`) — the caller in electron-main supplies the
 * real environment, which keeps this testable from `test/common` and usable from any layer.
 */
export const resolveApiKeyWithEnv = (configuredKey: string | undefined, providerName: ProviderId, env: EnvVars): string => {
	if (configuredKey?.trim()) { return configuredKey; }
	const envVarName = apiKeyEnvVarOfProvider[providerName as keyof typeof apiKeyEnvVarOfProvider];
	if (!envVarName) { return configuredKey ?? ''; }
	return (env[envVarName] ?? '').trim();
};

/**
 * Same fallback applied to the whole provider-settings bag, so every downstream branch reading
 * `settingsOfProvider[providerName].apiKey` picks the env key up without repeating the resolution.
 * Returns the original object untouched when there is nothing to substitute.
 */
export const withEnvApiKey = (settingsOfProvider: SettingsOfProvider, providerName: ProviderId, env: EnvVars): SettingsOfProvider => {
	const providerCfg = settingsOfProvider[providerName] as { apiKey?: string } | undefined;
	if (!providerCfg || providerCfg.apiKey?.trim()) { return settingsOfProvider; }
	const resolved = resolveApiKeyWithEnv(providerCfg.apiKey, providerName, env);
	if (!resolved) { return settingsOfProvider; }
	// Computed-key spread widens the mapped part of SettingsOfProvider — the value is a valid entry
	// for `providerName`, so narrow it back.
	return { ...settingsOfProvider, [providerName]: { ...providerCfg, apiKey: resolved } } as SettingsOfProvider;
};

type CustomSettingName = UnionOfKeys<typeof defaultProviderSettings[ProviderName]>;
type CustomProviderSettings<providerName extends ProviderName> = {
	[k in CustomSettingName]: k extends keyof typeof defaultProviderSettings[providerName] ? string : undefined
};
export const customSettingNamesOfProvider = (providerName: ProviderId) => {
	// Config providers (providers.json) have no built-in field schema; the only editable field in
	// the Settings card is the API key (baseURL/headers stay file-owned).
	if (!isBuiltinProviderId(providerName)) { return ['apiKey'] as CustomSettingName[]; }
	return Object.keys(defaultProviderSettings[providerName]) as CustomSettingName[];
};



export type VibeideStatefulModelInfo = { // <-- STATEFUL
	modelName: string;
	type: 'default' | 'autodetected' | 'custom';
	isHidden: boolean; // whether or not the user is hiding it (switched off)
	/** DYNAMIC providers only (.vibe/providers.json): marks a model whose caps are overridden by a file
	 *  `static` entry (`override`) or defined only in the file (`manual`). Drives the «Модели» tab badge. */
	fileNote?: 'override' | 'manual';
};



type CommonProviderSettings = {
	_didFillInProviderSettings: boolean | undefined; // undefined initially, computed when user types in all fields
	models: VibeideStatefulModelInfo[];
};

export type SettingsAtProvider<providerName extends ProviderName> = CustomProviderSettings<providerName> & CommonProviderSettings;

/**
 * Supertype every provider entry in state satisfies — built-in (`SettingsAtProvider`) and
 * config-provider seed (`DynamicProviderSeed`) alike. This is what indexing `settingsOfProvider`
 * with a plain `ProviderId` yields, so consumers work on the MERGED provider set without casts.
 * The `keyStatus`/`keySource`/`keyless` extras only ever appear on config-provider seeds.
 */
export type AnyProviderSettings = CommonProviderSettings & { [k in CustomSettingName]?: string } & {
	keyStatus?: 'valid' | 'invalid' | 'error' | 'pending' | 'unverified' | 'none';
	keySource?: 'gui' | 'env' | 'ref' | 'none';
	keyless?: true;
};

// part of state — built-ins are precisely typed; any other `ProviderId` key is a config-provider
// entry seeded from providers.json (workspace or ~/.vibe). ONE map, both sources.
export type SettingsOfProvider = {
	[providerName in ProviderName]: SettingsAtProvider<providerName>
} & {
	[id: ProviderId]: AnyProviderSettings;
};


export type SettingName = keyof SettingsAtProvider<ProviderName>;

type DisplayInfoForProviderName = {
	title: string;
	desc?: string;
};

/** Названия вендоров, чьи провайдеры пришли файлами набора: id файла в любом написании читается как вендор. */
const VENDOR_TITLES: Readonly<Record<ProviderVendor, () => string>> = {
	anthropic: () => 'Anthropic',
	openAI: () => 'OpenAI',
	gemini: () => 'Gemini',
	xAI: () => 'Grok (xAI)',
	mistral: () => 'Mistral',
	groq: () => 'Groq',
	googleVertex: () => 'Google Vertex AI',
	microsoftAzure: () => 'Microsoft Azure OpenAI',
	awsBedrock: () => 'AWS Bedrock',
	pollinations: () => 'Pollinations',
	openAICompatible: () => localize('vibeide.provider.openAICompatible', 'Совместимо с OpenAI API'),
};

export const displayInfoOfProviderName = (providerName: ProviderId): DisplayInfoForProviderName => {
	if (providerName === 'deepseek') {
		return { title: 'DeepSeek', };
	}
	else if (providerName === 'openRouter') {
		return { title: 'OpenRouter', };
	}
	else if (providerName === 'ollama') {
		return { title: 'Ollama', };
	}
	else if (providerName === 'vLLM') {
		return { title: 'vLLM', };
	}
	else if (providerName === 'liteLLM') {
		return { title: 'LiteLLM', };
	}
	else if (providerName === 'lmStudio') {
		return { title: 'LM Studio', };
	}
	else if (providerName === 'openCodeZen') {
		return { title: 'OpenCode Zen', };
	}
	else if (providerName === 'minimax') {
		return { title: 'MiniMax', };
	}
	else if (providerName === 'lmRoute') {
		return { title: 'LM Router', };
	}

	// Провайдер из файла набора: если его id — вендор, то названием служит имя вендора (в карточке — имя из самого файла)
	const vendor = vendorOfProviderId(providerName);
	if (vendor) {
		return { title: VENDOR_TITLES[vendor]() };
	}

	// Dynamic providers (.vibe/providers.json) carry ids that aren't compile-time union members.
	// Don't throw — surface the id as the title so the model picker (getOptionDropdownDetail) and any
	// other caller render instead of crashing the subtree. The picker already shows the full name in
	// the option label; this is just the secondary provider detail.
	return { title: providerName };
};

/** Подсказки под полем ключа вендоров, чьи провайдеры пришли файлами набора (ссылки на получение ключа). */
const VENDOR_SUBTEXT_MD: Readonly<Record<ProviderVendor, string>> = {
	anthropic: '[Ключ API](https://console.anthropic.com/settings/keys).',
	openAI: '[Ключ API](https://platform.openai.com/api-keys).',
	gemini: '[Ключ API](https://aistudio.google.com/apikey). [Лимиты](https://ai.google.dev/gemini-api/docs/rate-limits#current-rate-limits).',
	groq: '[Ключ API](https://console.groq.com/keys).',
	xAI: '[Ключ API](https://console.x.ai).',
	mistral: '[Ключ API](https://console.mistral.ai/api-keys).',
	openAICompatible: 'Любой провайдер с совместимым с OpenAI API (llama.cpp и др.).',
	googleVertex: 'Вход через Google: `gcloud auth application-default login`, ключ не нужен. [Конечные точки](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library), [регионы](https://cloud.google.com/vertex-ai/docs/general/locations#available-regions).',
	microsoftAzure: '[Конечные точки](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle), [ключ API](https://learn.microsoft.com/en-us/azure/search/search-security-api-keys?tabs=rest-use%2Cportal-find%2Cportal-query#find-existing-keys).',
	awsBedrock: 'Через прокси LiteLLM или AWS [Bedrock-Access-Gateway](https://github.com/aws-samples/bedrock-access-gateway). [Документация LiteLLM Bedrock](https://docs.litellm.ai/docs/providers/bedrock).',
	pollinations: '[Ключ API](https://enter.pollinations.ai/). [Документация API](https://enter.pollinations.ai/api/docs).',
};

export const subTextMdOfProviderName = (providerName: ProviderId): string => {

	if (providerName === 'deepseek') { return '[Ключ API](https://platform.deepseek.com/api_keys).'; }
	if (providerName === 'openRouter') { return '[Ключ API](https://openrouter.ai/settings/keys). [Лимиты](https://openrouter.ai/docs/api-reference/limits).'; }
	if (providerName === 'ollama') { return 'Про свои [конечные точки](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-expose-ollama-on-my-network).'; }
	if (providerName === 'vLLM') { return 'Про [конечные точки](https://docs.vllm.ai/en/latest/getting_started/quickstart.html#openai-compatible-server).'; }
	if (providerName === 'lmStudio') { return 'Про [конечные точки OpenAI](https://lmstudio.ai/docs/app/api/endpoints/openai).'; }
	if (providerName === 'liteLLM') { return '[Совместимые конечные точки](https://docs.litellm.ai/docs/providers/openai_compatible).'; }
	if (providerName === 'lmRoute') { return 'OpenAI-совместимый агрегатор. Hosted: `https://api.lmrouter.com/openai/v1`, либо self-hosted endpoint. [Исходники](https://github.com/LMRouter/lmrouter).'; }
	if (providerName === 'openCodeZen') { return 'Ключ на [opencode.ai/zen](https://opencode.ai/zen). Бесплатные модели: MiniMax M2.5 Free, Ling 2.6 Flash и др. ([документация Zen](https://opencode.ai/docs/zen)).'; }
	if (providerName === 'minimax') { return '[Ключ API](https://platform.minimax.io/user-center/basic-information/interface-key). OpenAI-совместимый API. Модели: MiniMax-M3 (контекст 1M, мультимодальная, thinking переключается), MiniMax-M2.'; }

	const vendor = vendorOfProviderId(providerName);
	if (vendor) { return VENDOR_SUBTEXT_MD[vendor]; }

	// Провайдер из файла (`.vibe/providers/*.jsonc` или `.vibe/providers.json`) вне встроенного списка — исключений не бросаем,
	// только подсказываем, откуда берётся ключ. Ссылки на документацию и ключ лежат в самом файле, а не здесь.
	return 'Провайдер из файла `.vibe/providers/`. Введите ключ здесь или задайте `apiKeyEnv` в `.vibe/.env`.';
};

type DisplayInfo = {
	title: string;
	placeholder: string;
	isPasswordField?: boolean;
};
export const displayInfoOfSettingName = (providerName: ProviderId, settingName: SettingName): DisplayInfo => {
	if (settingName === 'apiKey') {
		const vendor = vendorOfProviderId(providerName);
		return {
			title: localize('vibeide.settings.apiKey', 'Ключ API'),

			// **Please follow this convention**:
			// The word "key..." here is a placeholder for the hash. For example, sk-ant-key... means the key will look like sk-ant-abcdefg123...
			placeholder: vendor === 'anthropic' ? 'sk-ant-key...' : // sk-ant-api03-key
				vendor === 'openAI' ? 'sk-proj-key...' :
					providerName === 'deepseek' ? 'sk-key...' :
						providerName === 'openRouter' ? 'sk-or-key...' : // sk-or-v1-key
							vendor === 'gemini' ? 'AIzaSy...' :
								vendor === 'groq' ? 'gsk_key...' :
									vendor === 'openAICompatible' ? 'sk-key...' :
										vendor === 'xAI' ? 'xai-key...' :
											vendor === 'mistral' ? 'api-key...' :
												vendor === 'googleVertex' ? 'AIzaSy...' :
													vendor === 'microsoftAzure' ? 'key-...' :
														vendor === 'awsBedrock' ? 'key-...' :
															vendor === 'pollinations' ? 'sk-... or pk-...' :
																providerName === 'openCodeZen' ? 'opencode-key...' :
																	providerName === 'minimax' ? 'eyJ...' :
																		providerName === 'lmRoute' ? 'lmrouter-key...' :
																			'',

			isPasswordField: true,
		};
	}
	else if (settingName === 'endpoint') {
		return {
			title: providerName === 'ollama' ? 'Конечная точка' :
				providerName === 'vLLM' ? 'Конечная точка' :
					providerName === 'lmStudio' ? 'Конечная точка' :
						providerName === 'liteLLM' ? 'baseURL' :
							providerName === 'lmRoute' ? 'baseURL' :
								'(нет)',

			placeholder: providerName === 'ollama' ? defaultProviderSettings.ollama.endpoint
				: providerName === 'vLLM' ? defaultProviderSettings.vLLM.endpoint
					: providerName === 'lmStudio' ? defaultProviderSettings.lmStudio.endpoint
						: providerName === 'liteLLM' ? 'http://localhost:4000'
							: providerName === 'lmRoute' ? 'https://api.lmrouter.com/openai/v1'
								: '(нет)',


		};
	}
	else if (settingName === 'publicCatalog') {
		return {
			title: localize('vibeide.settings.publicCatalog', 'Публичный каталог'),
			placeholder: '',
		};
	}
	else if (settingName === '_didFillInProviderSettings') {
		return {
			title: localize('vibeide.settings.notApplicable', '(нет)'),
			placeholder: localize('vibeide.settings.notApplicable', '(нет)'),
		};
	}
	else if (settingName === 'models') {
		return {
			title: localize('vibeide.settings.notApplicable', '(нет)'),
			placeholder: localize('vibeide.settings.notApplicable', '(нет)'),
		};
	}

	throw new Error(`displayInfo: Unknown setting name: "${settingName}"`);
};


const defaultCustomSettings: Record<CustomSettingName, undefined> = {
	apiKey: undefined,
	endpoint: undefined,
	/** OpenRouter: `'1'` = fetch public /v1/models without API key */
	publicCatalog: undefined,
};


const modelInfoOfDefaultModelNames = (defaultModelNames: string[]): { models: VibeideStatefulModelInfo[] } => {
	return {
		models: defaultModelNames.map((modelName, i) => ({
			modelName,
			type: 'default',
			isHidden: defaultModelNames.length >= 10, // hide all models if there are a ton of them, and make user enable them individually
		}))
	};
};

// used when waiting and for a type reference
export const defaultSettingsOfProvider: SettingsOfProvider = {
	deepseek: {
		...defaultCustomSettings,
		...defaultProviderSettings.deepseek,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.deepseek),
		_didFillInProviderSettings: undefined,
	},
	liteLLM: {
		...defaultCustomSettings,
		...defaultProviderSettings.liteLLM,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.liteLLM),
		_didFillInProviderSettings: undefined,
	},
	lmStudio: {
		...defaultCustomSettings,
		...defaultProviderSettings.lmStudio,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.lmStudio),
		_didFillInProviderSettings: undefined,
	},
	openRouter: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.openRouter,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openRouter),
		_didFillInProviderSettings: undefined,
	},
	ollama: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.ollama,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.ollama),
		_didFillInProviderSettings: undefined,
	},
	vLLM: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.vLLM,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.vLLM),
		_didFillInProviderSettings: undefined,
	},
	openCodeZen: {
		...defaultCustomSettings,
		...defaultProviderSettings.openCodeZen,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openCodeZen),
		_didFillInProviderSettings: undefined,
	},
	minimax: {
		...defaultCustomSettings,
		...defaultProviderSettings.minimax,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.minimax),
		_didFillInProviderSettings: undefined,
	},
	lmRoute: {
		...defaultCustomSettings,
		...defaultProviderSettings.lmRoute,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.lmRoute),
		_didFillInProviderSettings: undefined,
	},
};


// `providerName` is a ProviderId: built-in OR config provider — selections address the MERGED set.
export type ModelSelection =
	| { providerName: ProviderId; modelName: string }
	| { providerName: 'auto'; modelName: 'auto' }; // Special "Auto" selection for automatic routing

export const modelSelectionsEqual = (m1: ModelSelection, m2: ModelSelection) => {
	return m1.modelName === m2.modelName && m1.providerName === m2.providerName;
};

export const isAutoModelSelection = (selection: ModelSelection | null): boolean => {
	return selection?.providerName === 'auto' && selection?.modelName === 'auto';
};

/**
 * Type guard to check if a ModelSelection addresses a real provider (not "auto").
 */
export const isValidProviderModelSelection = (selection: ModelSelection): selection is { providerName: ProviderId; modelName: string } => {
	return selection.providerName !== 'auto' && selection.modelName !== 'auto';
};

// this is a state
export const featureNames = ['Chat', 'Ctrl+K', 'Autocomplete', 'Apply', 'SCM'] as const;
export type ModelSelectionOfFeature = Record<(typeof featureNames)[number], ModelSelection | null>;
export type FeatureName = keyof ModelSelectionOfFeature;

export const displayInfoOfFeatureName = (featureName: FeatureName) => {
	// editor:
	if (featureName === 'Autocomplete') { return 'Автодополнение'; }
	else if (featureName === 'Ctrl+K') { return 'Быстрое редактирование'; }
	// sidebar:
	else if (featureName === 'Chat') { return 'Чат'; }
	else if (featureName === 'Apply') { return 'Применить правки (Apply)'; }
	// source control:
	else if (featureName === 'SCM') { return 'Генератор сообщений коммита'; }
	else { throw new Error(`Feature Name ${featureName} not allowed`); }
};


// the models of these can be refreshed (in theory all can, but not all should)
export const refreshableProviderNames = localProviderNames;
export type RefreshableProviderName = typeof refreshableProviderNames[number];

// models that come with download buttons
export const hasDownloadButtonsOnModelsProviderNames = ['ollama'] as const satisfies ProviderName[];





// use this in isFeatuerNameDissbled
export const isProviderNameDisabled = (providerName: ProviderId, settingsState: VibeideSettingsState) => {

	const settingsAtProvider = settingsState.settingsOfProvider[providerName];
	// Dynamic providers (.vibe/providers.json) have no built-in settings entry. Their selectable
	// models are injected (key-gated) by the dynamic-providers service, so if such a provider is the
	// current selection it's already "connected" — treat as enabled rather than dereferencing a
	// missing entry (was: TypeError reading 'models' on model select).
	if (!settingsAtProvider) { return false; }
	const isAutodetected = (refreshableProviderNames as string[]).includes(providerName);

	const isDisabled = settingsAtProvider.models.length === 0;
	if (isDisabled) {
		return isAutodetected ? 'providerNotAutoDetected' : (!settingsAtProvider._didFillInProviderSettings ? 'notFilledIn' : 'addModel');
	}
	return false;
};

export const isFeatureNameDisabled = (featureName: FeatureName, settingsState: VibeideSettingsState) => {
	// if has a selected provider, check if it's enabled
	const selectedProvider = settingsState.modelSelectionOfFeature[featureName];

	if (selectedProvider) {
		// "Auto" option is always enabled (it will route to available models)
		if (selectedProvider.providerName === 'auto' && selectedProvider.modelName === 'auto') {
			return false;
		}
		const { providerName } = selectedProvider;
		return isProviderNameDisabled(providerName, settingsState);
	}

	// The MERGED provider set — a configured config provider (providers.json) must count exactly
	// like a built-in here, or the UI tells a fully-working setup that "no provider is configured".
	const allProviderIds = Object.keys(settingsState.settingsOfProvider);

	// if there are any models they can turn on, tell them that
	const canTurnOnAModel = !!allProviderIds.find(providerName => (settingsState.settingsOfProvider[providerName]?.models ?? []).filter(m => m.isHidden).length !== 0);
	if (canTurnOnAModel) { return 'needToEnableModel'; }

	// if there are any providers filled in, then they just need to add a model
	const anyFilledIn = !!allProviderIds.find(providerName => settingsState.settingsOfProvider[providerName]?._didFillInProviderSettings);
	if (anyFilledIn) { return 'addModel'; }

	return 'addProvider';
};







export type ChatMode = 'agent' | 'gather' | 'normal' | 'plan';

/**
 * Code-minimalism discipline injected into the agent system prompt.
 * 'off' — no discipline block; 'lite' — reuse-first + YAGNI reminder;
 * 'full' — the complete minimalism ladder + vibe-later markers;
 * 'ultra' — full ladder + smallest-reviewable-diff pressure.
 */
export type MinimalismMode = 'off' | 'lite' | 'full' | 'ultra';


export type GlobalSettings = {
	autoRefreshModels: boolean;
	/**
	 * Show local providers (Ollama / vLLM / LM Studio) in the "Модели" section even when they hold
	 * no models. They count as configured by their default endpoint alone, so without this they
	 * would occupy the list on every machine that never installed a local server.
	 */
	showEmptyLocalProviders: boolean;
	aiInstructions: string;
	enableAutocomplete: boolean;
	syncApplyToChat: boolean;
	syncSCMToChat: boolean;
	enableFastApply: boolean;
	chatMode: ChatMode;
	autoApprove: { [approvalType in ToolApprovalType]?: boolean };
	showInlineSuggestions: boolean;
	includeToolLintErrors: boolean;
	isOnboardingComplete: boolean;
	disableSystemMessage: boolean;
	autoAcceptLLMChanges: boolean;
	enableAutoTuneOnPull: boolean;
	enableRepoIndexer?: boolean;
	useHeadlessBrowsing?: boolean;
	// Image QA Pipeline settings
	/** Master switch for the local OCR/QA pipeline. When false (default), images go directly to vision-capable LLMs and Tesseract is never invoked. */
	imageQAPipelineEnabled: boolean;
	imageQAAllowRemoteModels: boolean;
	imageQAEnableHybridMode: boolean;
	imageQADevMode: boolean;
	enableMemories?: boolean; // Enable persistent project memories (default: true)
	enableYOLOMode?: boolean; // Enable YOLO mode: auto-apply low-risk edits (default: false)
	yoloRiskThreshold?: number; // Maximum risk score for auto-apply (default: 0.2)
	yoloConfidenceThreshold?: number; // Minimum confidence score for auto-apply (default: 0.7)
	enableInlineCodeReview?: boolean; // Enable inline code review annotations (default: true)
	reviewSeverityFilter?: 'all' | 'warning+error'; // Filter annotations by severity (default: 'all')
	// Audit log settings
	audit?: {
		enable?: boolean; // Enable audit logging (default: false)
		path?: string; // Custom path for audit log (default: ${workspaceRoot}/.vibe/audit.jsonl)
		rotationSizeMB?: number; // Rotate log file at this size (default: 10)
	};
	// Indexer settings
	index?: {
		ast?: boolean; // Use tree-sitter AST parsing (default: true)
	};
	// RAG settings
	rag?: {
		vectorStore?: 'none' | 'qdrant' | 'chroma'; // Vector store provider (default: 'none')
		vectorStoreUrl?: string; // Vector store URL (default: http://localhost:6333 for Qdrant, http://localhost:8000 for Chroma)
	};
	// Performance settings
	perf?: {
		enable?: boolean; // Enable performance instrumentation (default: false)
		renderBatchMs?: number; // Token batch interval in ms (default: 50)
		virtualizeChat?: boolean; // Enable chat virtualization (default: false)
		autoCompleteDebounceMs?: number; // Autocomplete debounce delay in ms (default: 35)
		indexerCpuBudget?: number; // Indexer CPU budget (0-1, default: 0.2 = 20% of core)
		indexerParallelism?: number; // Indexer parallelism limit (default: 2)
		routerCacheTtlMs?: number; // Router cache TTL in ms (default: 2000)
	};
	// Local-First AI: When enabled, heavily bias router toward local models
	localFirstAI?: boolean; // Prefer local models over cloud models (default: false)
	/** When true, built-in and MCP tool calls run without per-step approval (incl. deletions & terminal). Default ON — most users want unattended runs; switch off for per-step control. */
	chatAgentAutopilot?: boolean;
	/** When true, `.vibe/README.md` is created on workspace init if missing (together with other `.vibe/` defaults). */
	createVibeReadmeOnWorkspaceInit: boolean;
	/** When true, render date/time under each chat message and next to checkpoints. Single switch for all chat timestamps. */
	showChatTimestamps: boolean;
	/** Mirrors `vibeide.global.minimalismMode` (VS Code config is the source of truth, like localFirstAI). */
	minimalismMode: MinimalismMode;
};

export const defaultGlobalSettings: GlobalSettings = {
	autoRefreshModels: true,
	showEmptyLocalProviders: false,
	aiInstructions: '',
	enableAutocomplete: false,
	syncApplyToChat: true,
	syncSCMToChat: true,
	enableFastApply: true,
	chatMode: 'agent',
	autoApprove: {},
	showInlineSuggestions: true,
	includeToolLintErrors: true,
	isOnboardingComplete: false,
	disableSystemMessage: false,
	autoAcceptLLMChanges: false,
	enableAutoTuneOnPull: true,
	enableRepoIndexer: true,
	useHeadlessBrowsing: true, // Use headless BrowserWindow for better content extraction (default)
	// Image QA Pipeline defaults
	imageQAPipelineEnabled: false, // OFF by default — native vision in Anthropic/OpenAI/Gemini outperforms local Tesseract OCR; opt-in for local-only setups.
	imageQAAllowRemoteModels: false, // Local-first by default
	imageQAEnableHybridMode: true,
	imageQADevMode: false,
	enableMemories: true, // Enable memories by default
	enableYOLOMode: false, // YOLO mode disabled by default (requires explicit opt-in)
	yoloRiskThreshold: 0.2, // Auto-apply edits with risk < 0.2
	yoloConfidenceThreshold: 0.7, // Auto-apply edits with confidence > 0.7
	enableInlineCodeReview: true, // Enable inline code review annotations by default
	reviewSeverityFilter: 'all', // Show all annotations by default
	// Audit log defaults
	audit: {
		enable: false, // Audit logging disabled by default
		path: undefined, // Will use ${workspaceRoot}/.vibe/audit.jsonl
		rotationSizeMB: 10,
	},
	// Indexer defaults
	index: {
		ast: true, // AST parsing enabled by default
	},
	// RAG defaults
	rag: {
		vectorStore: 'none', // No vector store by default
		vectorStoreUrl: undefined, // Will use default URLs per provider
	},
	// Performance defaults (all optimizations enabled by default)
	perf: {
		enable: true, // Performance instrumentation enabled by default
		renderBatchMs: 50, // 50ms token batching
		virtualizeChat: false, // Chat virtualization disabled by default (requires react-window)
		autoCompleteDebounceMs: 35, // 35ms autocomplete debounce (optimized from 500ms)
		indexerCpuBudget: 0.2, // 20% of a core (CPU throttling enabled)
		indexerParallelism: 2, // 2 parallel workers (parallelism limit enabled)
		routerCacheTtlMs: 2000, // 2 second cache TTL (caching enabled)
	},
	localFirstAI: false, // Local-First AI disabled by default (users can enable for privacy/performance)
	chatAgentAutopilot: true, // ON by default (paired with iterations counter defaulting to 0/∞); explicit user choice is persisted and wins
	createVibeReadmeOnWorkspaceInit: true,
	showChatTimestamps: true,
	minimalismMode: 'lite', // Gentle reuse-first discipline by default; 'full'/'ultra' are explicit opt-ins
};

export type GlobalSettingName = keyof GlobalSettings;
export const globalSettingNames = Object.keys(defaultGlobalSettings) as GlobalSettingName[];












export type ModelSelectionOptions = {
	reasoningEnabled?: boolean;
	reasoningBudget?: number;
	reasoningEffort?: string;
};

// Keyed by ProviderId — per-model options/overrides apply to config providers exactly like
// built-ins. Reads on an id that never stored anything yield `undefined` (callers optional-chain).
export type OptionsOfModelSelection = {
	[featureName in FeatureName]: {
		[providerName: ProviderId]: {
			[modelName: string]: ModelSelectionOptions | undefined;
		} | undefined;
	}
};





export type OverridesOfModel = {
	[providerName: ProviderId]: {
		[modelName: string]: Partial<ModelOverrides> | undefined;
	}
};


const overridesOfModel: Partial<OverridesOfModel> = {};
for (const providerName of providerNames) { overridesOfModel[providerName] = {}; }
export const defaultOverridesOfModel: OverridesOfModel = overridesOfModel as OverridesOfModel;



export interface MCPUserStateOfName {
	[serverName: string]: MCPUserState | undefined;
}

export interface MCPUserState {
	isOn: boolean;
}
