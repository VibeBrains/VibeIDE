/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { defaultModelsOfProvider, defaultProviderSettings, ModelOverrides } from './modelCapabilities.js';
import { ToolApprovalType } from './toolsServiceTypes.js';
import { VibeideSettingsState } from './vibeideSettingsService.js';


type UnionOfKeys<T> = T extends T ? keyof T : never;



export type ProviderName = keyof typeof defaultProviderSettings;
export const providerNames = Object.keys(defaultProviderSettings) as ProviderName[];

export const localProviderNames = ['ollama', 'vLLM', 'lmStudio'] satisfies ProviderName[]; // all local names
export const nonlocalProviderNames = providerNames.filter((name) => !(localProviderNames as string[]).includes(name)); // all non-local names

/**
 * Preference order for "Auto" model resolution — when user picks
 * `providerName: 'auto', modelName: 'auto'`, we walk this list and pick the
 * first provider that has `_didFillInProviderSettings === true` and at least
 * one non-hidden configured model. Order is hand-curated: cloud-flagship
 * providers first (Anthropic / OpenAI / Gemini), then alternative clouds
 * (xAI / Mistral / DeepSeek / Groq), then local (Ollama / vLLM / LMStudio),
 * then generic aggregators (OpenAI-compatible / OpenRouter / LiteLLM /
 * Pollinations), then VibeIDE-aligned aggregators (OpenCode Zen / Go).
 *
 * SINGLE SOURCE OF TRUTH — used by chatThreadService._findModelSelectionForId,
 * vibeideSettingsService.resolveAutoModelSelection, errorDetectionService and
 * nlShellParserService for their respective auto-fallback resolutions. Used to
 * be hand-copy-pasted 4× before this const was added. `satisfies ProviderName[]`
 * forces TS to fail-loud if a value isn't in `ProviderName`. Adding a new
 * provider = add the name HERE (and to defaultProviderSettings); the four
 * callers automatically pick it up.
 */
export const autoModelFallbackProviderOrder = ['anthropic', 'openAI', 'gemini', 'xAI', 'mistral', 'deepseek', 'groq', 'ollama', 'vLLM', 'lmStudio', 'openAICompatible', 'openRouter', 'liteLLM', 'pollinations', 'openCodeZen', 'openCodeGo', 'minimax'] satisfies ProviderName[];

type CustomSettingName = UnionOfKeys<typeof defaultProviderSettings[ProviderName]>;
type CustomProviderSettings<providerName extends ProviderName> = {
	[k in CustomSettingName]: k extends keyof typeof defaultProviderSettings[providerName] ? string : undefined
};
export const customSettingNamesOfProvider = (providerName: ProviderName) => {
	const builtin = defaultProviderSettings[providerName];
	// Dynamic providers (.vibe/providers.json) have no built-in field schema; the only editable field in
	// the Settings card is the API key (baseURL/headers stay file-owned).
	if (!builtin) { return ['apiKey'] as CustomSettingName[]; }
	return Object.keys(builtin) as CustomSettingName[];
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

// part of state
export type SettingsOfProvider = {
	[providerName in ProviderName]: SettingsAtProvider<providerName>
};


export type SettingName = keyof SettingsAtProvider<ProviderName>;

type DisplayInfoForProviderName = {
	title: string;
	desc?: string;
};

export const displayInfoOfProviderName = (providerName: ProviderName): DisplayInfoForProviderName => {
	if (providerName === 'anthropic') {
		return { title: 'Anthropic', };
	}
	else if (providerName === 'openAI') {
		return { title: 'OpenAI', };
	}
	else if (providerName === 'deepseek') {
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
	else if (providerName === 'openAICompatible') {
		return { title: localize('vibeide.provider.openAICompatible', 'Совместимо с OpenAI API'), };
	}
	else if (providerName === 'gemini') {
		return { title: 'Gemini', };
	}
	else if (providerName === 'groq') {
		return { title: 'Groq', };
	}
	else if (providerName === 'xAI') {
		return { title: 'Grok (xAI)', };
	}
	else if (providerName === 'mistral') {
		return { title: 'Mistral', };
	}
	else if (providerName === 'googleVertex') {
		return { title: 'Google Vertex AI', };
	}
	else if (providerName === 'microsoftAzure') {
		return { title: 'Microsoft Azure OpenAI', };
	}
	else if (providerName === 'awsBedrock') {
		return { title: 'AWS Bedrock', };
	}
	else if (providerName === 'pollinations') {
		return { title: 'Pollinations', };
	}
	else if (providerName === 'openCodeZen') {
		return { title: 'OpenCode Zen', };
	}
	else if (providerName === 'openCodeGo') {
		return { title: 'OpenCode Go', };
	}
	else if (providerName === 'minimax') {
		return { title: 'MiniMax', };
	}
	else if (providerName === 'lmRoute') {
		return { title: 'LM Router', };
	}

	// Dynamic providers (.vibe/providers.json) carry ids that aren't compile-time union members.
	// Don't throw — surface the id as the title so the model picker (getOptionDropdownDetail) and any
	// other caller render instead of crashing the subtree. The picker already shows the full name in
	// the option label; this is just the secondary provider detail.
	return { title: providerName };
};

export const subTextMdOfProviderName = (providerName: ProviderName): string => {

	if (providerName === 'anthropic') { return '[Ключ API](https://console.anthropic.com/settings/keys).'; }
	if (providerName === 'openAI') { return '[Ключ API](https://platform.openai.com/api-keys).'; }
	if (providerName === 'deepseek') { return '[Ключ API](https://platform.deepseek.com/api_keys).'; }
	if (providerName === 'openRouter') { return '[Ключ API](https://openrouter.ai/settings/keys). [Лимиты](https://openrouter.ai/docs/api-reference/limits).'; }
	if (providerName === 'gemini') { return '[Ключ API](https://aistudio.google.com/apikey). [Лимиты](https://ai.google.dev/gemini-api/docs/rate-limits#current-rate-limits).'; }
	if (providerName === 'groq') { return '[Ключ API](https://console.groq.com/keys).'; }
	if (providerName === 'xAI') { return '[Ключ API](https://console.x.ai).'; }
	if (providerName === 'mistral') { return '[Ключ API](https://console.mistral.ai/api-keys).'; }
	if (providerName === 'openAICompatible') { return `Любой провайдер с совместимым с OpenAI API (llama.cpp и др.).`; }
	if (providerName === 'googleVertex') { return 'Нужна аутентификация для Vertex. [Конечные точки](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library), [регионы](https://cloud.google.com/vertex-ai/docs/general/locations#available-regions).'; }
	if (providerName === 'microsoftAzure') { return '[Конечные точки](https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP), [ключ API](https://learn.microsoft.com/en-us/azure/search/search-security-api-keys?tabs=rest-use%2Cportal-find%2Cportal-query#find-existing-keys).'; }
	if (providerName === 'awsBedrock') { return 'Через прокси LiteLLM или AWS [Bedrock-Access-Gateway](https://github.com/aws-samples/bedrock-access-gateway). [Документация LiteLLM Bedrock](https://docs.litellm.ai/docs/providers/bedrock).'; }
	if (providerName === 'ollama') { return 'Про свои [конечные точки](https://github.com/ollama/ollama/blob/main/docs/faq.md#how-can-i-expose-ollama-on-my-network).'; }
	if (providerName === 'vLLM') { return 'Про [конечные точки](https://docs.vllm.ai/en/latest/getting_started/quickstart.html#openai-compatible-server).'; }
	if (providerName === 'lmStudio') { return 'Про [конечные точки OpenAI](https://lmstudio.ai/docs/app/api/endpoints/openai).'; }
	if (providerName === 'liteLLM') { return '[Совместимые конечные точки](https://docs.litellm.ai/docs/providers/openai_compatible).'; }
	if (providerName === 'lmRoute') { return 'OpenAI-совместимый агрегатор. Hosted: `https://api.lmrouter.com/openai/v1`, либо self-hosted endpoint. [Исходники](https://github.com/LMRouter/lmrouter).'; }
	if (providerName === 'pollinations') { return '[Ключ API](https://enter.pollinations.ai/). [Документация API](https://enter.pollinations.ai/api/docs).'; }
	if (providerName === 'openCodeZen') { return 'Ключ на [opencode.ai/zen](https://opencode.ai/zen). Бесплатные модели: MiniMax M2.5 Free, Ling 2.6 Flash и др. ([документация Zen](https://opencode.ai/docs/zen)).'; }
	if (providerName === 'openCodeGo') { return 'Подписка OpenCode Go — тот же аккаунт Zen. [Модели Go](https://dev.opencode.ai/docs/go) на opencode.ai/zen/go (Qwen, DeepSeek V4, …).'; }
	if (providerName === 'minimax') { return '[Ключ API](https://platform.minimax.io/user-center/basic-information/interface-key). OpenAI-совместимый API. Модели: MiniMax-M3 (контекст 1M, мультимодальная, thinking переключается), MiniMax-M2.'; }

	// Dynamic providers (.vibe/providers.json) aren't in the built-in list — don't throw, just hint at
	// where the key comes from. The provider's own docs/api-key URLs live in the file, not here.
	return 'Провайдер из `.vibe/providers.json`. Введите ключ здесь или задайте `apiKeyEnv` в `.vibe/.env`.';
};

type DisplayInfo = {
	title: string;
	placeholder: string;
	isPasswordField?: boolean;
};
export const displayInfoOfSettingName = (providerName: ProviderName, settingName: SettingName): DisplayInfo => {
	if (settingName === 'apiKey') {
		return {
			title: localize('vibeide.settings.apiKey', 'Ключ API'),

			// **Please follow this convention**:
			// The word "key..." here is a placeholder for the hash. For example, sk-ant-key... means the key will look like sk-ant-abcdefg123...
			placeholder: providerName === 'anthropic' ? 'sk-ant-key...' : // sk-ant-api03-key
				providerName === 'openAI' ? 'sk-proj-key...' :
					providerName === 'deepseek' ? 'sk-key...' :
						providerName === 'openRouter' ? 'sk-or-key...' : // sk-or-v1-key
							providerName === 'gemini' ? 'AIzaSy...' :
								providerName === 'groq' ? 'gsk_key...' :
									providerName === 'openAICompatible' ? 'sk-key...' :
										providerName === 'xAI' ? 'xai-key...' :
											providerName === 'mistral' ? 'api-key...' :
												providerName === 'googleVertex' ? 'AIzaSy...' :
													providerName === 'microsoftAzure' ? 'key-...' :
														providerName === 'awsBedrock' ? 'key-...' :
															providerName === 'pollinations' ? 'sk-... or pk-...' :
																providerName === 'openCodeZen' ? 'opencode-key...' :
																	providerName === 'openCodeGo' ? 'opencode-key...' :
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
						providerName === 'openAICompatible' ? 'baseURL' : // (не добавляйте /chat/completions)
							providerName === 'googleVertex' ? 'baseURL' :
								providerName === 'microsoftAzure' ? 'baseURL' :
									providerName === 'liteLLM' ? 'baseURL' :
										providerName === 'lmRoute' ? 'baseURL' :
											providerName === 'awsBedrock' ? 'Конечная точка' :
												'(нет)',

			placeholder: providerName === 'ollama' ? defaultProviderSettings.ollama.endpoint
				: providerName === 'vLLM' ? defaultProviderSettings.vLLM.endpoint
					: providerName === 'openAICompatible' ? 'https://my-website.com/v1'
						: providerName === 'lmStudio' ? defaultProviderSettings.lmStudio.endpoint
							: providerName === 'liteLLM' ? 'http://localhost:4000'
								: providerName === 'lmRoute' ? 'https://api.lmrouter.com/openai/v1'
									: providerName === 'awsBedrock' ? 'http://localhost:4000/v1'
										: '(нет)',


		};
	}
	else if (settingName === 'headersJSON') {
		return { title: localize('vibeide.settings.customHeaders', 'Произвольные заголовки'), placeholder: '{ "X-Request-Id": "..." }' };
	}
	else if (settingName === 'region') {
		// vertex only
		return {
			title: localize('vibeide.settings.region', 'Регион'),
			placeholder: providerName === 'googleVertex' ? defaultProviderSettings.googleVertex.region
				: providerName === 'awsBedrock'
					? defaultProviderSettings.awsBedrock.region
					: ''
		};
	}
	else if (settingName === 'azureApiVersion') {
		// azure only
		return {
			title: localize('vibeide.settings.azureApiVersion', 'Версия API'),
			placeholder: providerName === 'microsoftAzure' ? defaultProviderSettings.microsoftAzure.azureApiVersion
				: ''
		};
	}
	else if (settingName === 'project') {
		return {
			title: providerName === 'microsoftAzure' ? 'Ресурс'
				: providerName === 'googleVertex' ? 'Проект'
					: '',
			placeholder: providerName === 'microsoftAzure' ? 'my-resource'
				: providerName === 'googleVertex' ? 'my-project'
					: ''

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
	region: undefined, // googleVertex
	project: undefined,
	azureApiVersion: undefined,
	headersJSON: undefined,
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
	anthropic: {
		...defaultCustomSettings,
		...defaultProviderSettings.anthropic,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.anthropic),
		_didFillInProviderSettings: undefined,
	},
	openAI: {
		...defaultCustomSettings,
		...defaultProviderSettings.openAI,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openAI),
		_didFillInProviderSettings: undefined,
	},
	deepseek: {
		...defaultCustomSettings,
		...defaultProviderSettings.deepseek,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.deepseek),
		_didFillInProviderSettings: undefined,
	},
	gemini: {
		...defaultCustomSettings,
		...defaultProviderSettings.gemini,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.gemini),
		_didFillInProviderSettings: undefined,
	},
	xAI: {
		...defaultCustomSettings,
		...defaultProviderSettings.xAI,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.xAI),
		_didFillInProviderSettings: undefined,
	},
	mistral: {
		...defaultCustomSettings,
		...defaultProviderSettings.mistral,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.mistral),
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
	groq: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.groq,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.groq),
		_didFillInProviderSettings: undefined,
	},
	openRouter: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.openRouter,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openRouter),
		_didFillInProviderSettings: undefined,
	},
	openAICompatible: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.openAICompatible,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openAICompatible),
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
	googleVertex: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.googleVertex,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.googleVertex),
		_didFillInProviderSettings: undefined,
	},
	microsoftAzure: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.microsoftAzure,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.microsoftAzure),
		_didFillInProviderSettings: undefined,
	},
	awsBedrock: { // aggregator (serves models from multiple providers)
		...defaultCustomSettings,
		...defaultProviderSettings.awsBedrock,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.awsBedrock),
		_didFillInProviderSettings: undefined,
	},
	pollinations: {
		...defaultCustomSettings,
		...defaultProviderSettings.pollinations,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.pollinations),
		_didFillInProviderSettings: undefined,
	},
	openCodeZen: {
		...defaultCustomSettings,
		...defaultProviderSettings.openCodeZen,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openCodeZen),
		_didFillInProviderSettings: undefined,
	},
	openCodeGo: {
		...defaultCustomSettings,
		...defaultProviderSettings.openCodeGo,
		...modelInfoOfDefaultModelNames(defaultModelsOfProvider.openCodeGo),
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


export type ModelSelection =
	| { providerName: ProviderName; modelName: string }
	| { providerName: 'auto'; modelName: 'auto' }; // Special "Auto" selection for automatic routing

export const modelSelectionsEqual = (m1: ModelSelection, m2: ModelSelection) => {
	return m1.modelName === m2.modelName && m1.providerName === m2.providerName;
};

export const isAutoModelSelection = (selection: ModelSelection | null): boolean => {
	return selection?.providerName === 'auto' && selection?.modelName === 'auto';
};

/**
 * Type guard to check if a ModelSelection has a valid ProviderName (not "auto")
 */
export const isValidProviderModelSelection = (selection: ModelSelection): selection is { providerName: ProviderName; modelName: string } => {
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
export const isProviderNameDisabled = (providerName: ProviderName, settingsState: VibeideSettingsState) => {

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

	// if there are any models they can turn on, tell them that
	const canTurnOnAModel = !!providerNames.find(providerName => settingsState.settingsOfProvider[providerName].models.filter(m => m.isHidden).length !== 0);
	if (canTurnOnAModel) { return 'needToEnableModel'; }

	// if there are any providers filled in, then they just need to add a model
	const anyFilledIn = !!providerNames.find(providerName => settingsState.settingsOfProvider[providerName]._didFillInProviderSettings);
	if (anyFilledIn) { return 'addModel'; }

	return 'addProvider';
};







export type ChatMode = 'agent' | 'gather' | 'normal' | 'plan';


export type GlobalSettings = {
	autoRefreshModels: boolean;
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
};

export const defaultGlobalSettings: GlobalSettings = {
	autoRefreshModels: true,
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
};

export type GlobalSettingName = keyof GlobalSettings;
export const globalSettingNames = Object.keys(defaultGlobalSettings) as GlobalSettingName[];












export type ModelSelectionOptions = {
	reasoningEnabled?: boolean;
	reasoningBudget?: number;
	reasoningEffort?: string;
};

export type OptionsOfModelSelection = {
	[featureName in FeatureName]: Partial<{
		[providerName in ProviderName]: {
			[modelName: string]: ModelSelectionOptions | undefined;
		}
	}>
};





export type OverridesOfModel = {
	[providerName in ProviderName]: {
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
