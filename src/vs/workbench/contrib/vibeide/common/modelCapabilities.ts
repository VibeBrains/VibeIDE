/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Model Capabilities and Configuration
 *
 * This file centralizes all model definitions and capabilities for VibeIDE.
 *
 * Structure:
 * 1. defaultModelsOfProvider: Optional bootstrap (often empty) — UI lists are filled from IRemoteCatalogService and manual refresh in settings.
 * 2. Model-specific options (e.g., openAIModelOptions): Detailed capabilities per model id
 * 3. Provider settings: Fallback logic and provider-specific configurations
 *
 * When adding a **known** flagship model for heuristics/routing only (optional):
 * 1. Add detailed capabilities to provider-specific modelOptions / fallback.
 */

import { FeatureName, ModelSelectionOptions, OverridesOfModel, ProviderName } from './vibeideSettingsTypes.js';





// Key order controls Main Providers UI (see nonlocalProviderNames): OpenCode Zen + OpenCode + OpenRouter first, then free-tier-friendly, then by coding-model breadth/quality; locals last.
export const defaultProviderSettings = {
	// Featured aggregators block (shown first in Settings UI). Order is significant:
	// `providerNames` is `Object.keys(defaultProviderSettings)`, which is what the UI iterates.
	openCodeZen: {
		apiKey: '',
	},
	openCodeGo: {
		apiKey: '',
	},
	minimax: { // direct cloud, OpenAI-compatible — https://platform.minimax.io/docs/api-reference/text-chat-openai
		apiKey: '',
	},
	openRouter: {
		apiKey: '',
		/** `'1'` = load model list from OpenRouter public API without an API key (inference still needs a key). */
		publicCatalog: '0',
	},
	lmRoute: { // open-source aggregator, https://github.com/LMRouter/lmrouter — hosted at lmrouter.com or self-hosted
		endpoint: '',
		apiKey: '',
	},
	liteLLM: { // https://docs.litellm.ai/docs/providers/openai_compatible
		endpoint: '',
		apiKey: '',
	},
	// Cloud providers
	gemini: {
		apiKey: '',
	},
	groq: {
		apiKey: '',
	},
	pollinations: {
		apiKey: '',
	},
	anthropic: {
		apiKey: '',
	},
	openAI: {
		apiKey: '',
	},
	deepseek: {
		apiKey: '',
	},
	mistral: {
		apiKey: '',
	},
	xAI: {
		apiKey: '',
	},
	openAICompatible: {
		endpoint: '',
		apiKey: '',
		headersJSON: '{}', // default to {}
	},
	googleVertex: { // google https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		region: 'us-west2',
		project: '',
	},
	microsoftAzure: { // microsoft Azure Foundry
		project: '', // really 'resource'
		apiKey: '',
		azureApiVersion: '2024-05-01-preview',
	},
	awsBedrock: {
		apiKey: '',
		region: 'us-east-1', // add region setting
		endpoint: '', // optionally allow overriding default
	},
	// Local providers
	ollama: {
		endpoint: 'http://127.0.0.1:11434',
	},
	vLLM: {
		endpoint: 'http://localhost:8000',
	},
	lmStudio: {
		endpoint: 'http://localhost:1234',
	},

} as const;




export const defaultModelsOfProvider = {
	// Remote catalogs: lists come from IRemoteCatalogService (OpenAI-compatible /v1/models or provider APIs).
	openAI: [],
	anthropic: [],
	xAI: [],
	gemini: [],
	deepseek: [],
	// Local providers - models are autodetected dynamically
	// Users can add custom model IDs that will be recognized via fallback logic
	ollama: [ // Models autodetected from Ollama API
		// NOTE: Models are dynamically detected. Users can add custom model IDs.
		// Common models: qwen2.5-coder, llama3.1, deepseek-r1, devstral, etc.
	],
	vLLM: [ // Models autodetected from vLLM server
		// NOTE: Models are dynamically detected. Users can add custom model IDs.
	],
	lmStudio: [ // Models autodetected from LM Studio
		// NOTE: Models are dynamically detected. Users can add custom model IDs.
	],

	openRouter: [],
	groq: [],
	mistral: [],
	openAICompatible: [], // fallback
	googleVertex: [],
	microsoftAzure: [],
	awsBedrock: [],
	liteLLM: [],
	lmRoute: [],
	pollinations: [],
	openCodeZen: [],
	openCodeGo: [],
	// Empty like every other catalog-capable cloud provider: models come from
	// RemoteCatalogService (/v1/models) after the key is entered. Seeding here
	// would collide with catalog 'autodetected' rows (same modelName, different
	// `type`) — _modelsWithSwappedInNewModels only swaps within a type, so both
	// would survive and produce duplicate React keys in the model dropdown.
	minimax: [],


} as const satisfies Record<ProviderName, string[]>;



export type VibeideStaticModelInfo = { // not stateful
	// Void uses the information below to know how to handle each model.
	// for some examples, see openAIModelOptions and anthropicModelOptions (below).

	contextWindow: number; // input tokens
	reservedOutputTokenSpace: number | null; // reserve this much space in the context window for output, defaults to 4096 if null

	supportsSystemMessage: false | 'system-role' | 'developer-role' | 'separated'; // typically you should use 'system-role'. 'separated' means the system message is passed as a separate field (e.g. anthropic)
	// typically you should use 'openai-style'. Absent/undefined means "can't call tools
	// natively" → XML grammar in agent mode. NOTE: overrides persist "forced off" as
	// `null` (see ModelOverrides) because undefined keys are dropped by JSON/IPC;
	// getModelCapabilities normalizes null→undefined on read, so consumers never see null.
	specialToolFormat?: 'openai-style' | 'anthropic-style' | 'gemini-style';
	supportsFIM: boolean; // whether the model was specifically designed for autocomplete or "FIM" ("fill-in-middle" format)
	supportsVision?: boolean; // image input. Optional — undefined falls back to provider heuristics. Catalog-driven providers (OpenRouter, etc.) populate this from `architecture.input_modalities`.
	modality?: string; // display-only literal from catalog (e.g. "text+image->text"). Not used for routing — purely informational, surfaced in the model list UI.

	additionalOpenAIPayload?: { [key: string]: string }; // additional payload in the message body for requests that are openai-compatible (ollama, vllm, openai, openrouter, etc)

	// reasoning options
	reasoningCapabilities: false | {
		readonly supportsReasoning: true; // for clarity, this must be true if anything below is specified
		readonly canTurnOffReasoning: boolean; // whether or not the user can disable reasoning mode (false if the model only supports reasoning)
		readonly canIOReasoning: boolean; // whether or not the model actually outputs reasoning (eg o1 lets us control reasoning but not output it)
		readonly reasoningReservedOutputTokenSpace?: number; // overrides normal reservedOutputTokenSpace
		readonly reasoningSlider?:
		| undefined
		| { type: 'budget_slider'; min: number; max: number; default: number } // anthropic supports this (reasoning budget)
		| { type: 'effort_slider'; values: string[]; default: string }; // openai-compatible supports this (reasoning effort)

		// if it's open source and specifically outputs think tags, put the think tags here and we'll parse them out (e.g. ollama)
		readonly openSourceThinkTags?: [string, string];

		// For models that emit a NATIVE reasoning channel (`reasoning-delta`) AND duplicate the
		// same chain-of-thought as inline tags in the content (observed: MiniMax-M3). Unlike
		// `openSourceThinkTags`, this DOES NOT route the tag content to reasoning (the native
		// channel is authoritative) — it only STRIPS the duplicate tags from the answer text so
		// they don't leak into the body. Pair = [open, close].
		readonly stripThinkTagsFromContent?: [string, string];

		// the only other field related to reasoning is "providerReasoningIOSettings", which varies by provider.
	};


	// --- below is just informative, not used in sending / receiving, cannot be customized in settings ---
	cost: {
		input: number;
		output: number;
		cache_read?: number;
		cache_write?: number;
	};
	downloadable: false | {
		sizeGb: number | 'not-known';
	};
};
// if you change the above type, remember to update the Settings link



export const modelOverrideKeys = [
	'contextWindow',
	'reservedOutputTokenSpace',
	'supportsSystemMessage',
	'specialToolFormat',
	'supportsFIM',
	'supportsVision',
	'modality',
	'reasoningCapabilities',
	'additionalOpenAIPayload'
] as const;

// Reasons recognised by the runtime auto-downgrade pipeline (chatThreadService).
// See roadmap O.7 (Tool-call resilience). Stored in `ModelOverrides._reason`
// when an override is written automatically.
export type AutoDowngradeReason =
	| 'numeric-tool-name'
	| 'missing-required-field'
	| 'wrong-tool-name'
	| 'other';

// Auto-downgrade override TTL. After this many ms, an `_autoDetected` override
// is ignored by getModelCapabilities (the model gets a fresh chance on native
// FC, in case the aggregator/upstream fixed the quirk). Manual user overrides
// have no TTL. See roadmap O.4 (reset mechanism).
export const AUTO_DOWNGRADE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Manual override for the AI SDK adapter VibeIDE will use for this specific
 * model. Bypasses the models.dev catalog lookup in `aiSdkAdapter.ts`. Use when:
 *   - models.dev mis-classifies a model (e.g. lists Anthropic protocol but
 *     the aggregator actually serves it via OpenAI chat-completions),
 *   - you're testing a new model not yet in models.dev,
 *   - corporate-network strips the models.dev fetch and the default fallback
 *     to openai-compatible is wrong for a model that needs Anthropic format.
 *
 * Each value corresponds to a registered AI SDK adapter in `aiSdkAdapter.ts`.
 * Single source of truth — `API_PROTOCOL_VALUES` below feeds the type union,
 * the Settings UI validator, and (indirectly via `API_PROTOCOL_TO_SDK_NPM`)
 * the SDK routing in aiSdkAdapter. Add a new protocol in ONE place to enable
 * the override everywhere.
 *
 *   - 'openai-compat' → @ai-sdk/openai-compatible (generic chat-completions, default fallback)
 *   - 'openai'        → @ai-sdk/openai (native OpenAI, preserves provider-specific fields)
 *   - 'anthropic'     → @ai-sdk/anthropic (Messages wire format)
 *   - 'google'        → @ai-sdk/google (Gemini native — used when aggregator serves Gemini)
 *
 * NOTE: setting `apiProtocol: 'google'` only takes effect for models that flow
 * through `sendViaAISdk` (e.g. Gemini-through-aggregator). The standalone
 * `gemini` provider still uses its own `sendGeminiChat` path and ignores this
 * override — separate migration.
 */
export const API_PROTOCOL_VALUES = ['openai-compat', 'openai', 'anthropic', 'google'] as const;
export type ApiProtocolOverride = typeof API_PROTOCOL_VALUES[number];

/**
 * Maps each {@link ApiProtocolOverride} value to the AI SDK npm package name
 * that aiSdkAdapter's selection ternary checks against. Keep in sync with
 * `API_PROTOCOL_VALUES` — TypeScript will fail-loud if a new protocol is
 * added without an entry here, because the `Record<ApiProtocolOverride, ...>`
 * mapped type forbids missing keys.
 */
export const API_PROTOCOL_TO_SDK_NPM: Record<ApiProtocolOverride, string> = {
	'openai-compat': '@ai-sdk/openai-compatible',
	'openai': '@ai-sdk/openai',
	'anthropic': '@ai-sdk/anthropic',
	'google': '@ai-sdk/google',
};

export type ModelOverrides = Omit<Pick<
	VibeideStaticModelInfo,
	(typeof modelOverrideKeys)[number]
>, 'specialToolFormat'> & {
	/** `null` = persistable "forced off" (auto-downgrade to XML tools). `undefined` keys
	 *  are DROPPED by JSON/IPC serialization (renderer→main), so an
	 *  `{ specialToolFormat: undefined }` override silently evaporated and the main
	 *  process kept sending native tools (looping downgrade toast, 2026-06-07).
	 *  Read side normalizes null→undefined in getModelCapabilities. */
	specialToolFormat?: 'openai-style' | 'anthropic-style' | 'gemini-style' | null;
	/** Manual SDK-adapter selection. See {@link ApiProtocolOverride}. */
	apiProtocol?: ApiProtocolOverride;

	// Auto-downgrade metadata (see roadmap O.5). Underscore prefix marks these
	// as system fields, distinct from user-facing override keys.
	_autoDetected?: boolean;
	_detectedAt?: number;
	_reason?: AutoDowngradeReason;
};


// Heuristic free-tier detection — programmatic signals only, no network.
// 1) Pollinations is free by design.
// 2) `:free` suffix is the OpenRouter convention; LM Router preserves it when it proxies OpenRouter ids.
export const isFreeModel = (providerName: ProviderName, modelName: string): boolean => {
	if (providerName === 'pollinations') { return true; }
	return modelName.toLowerCase().endsWith(':free');
};


type ProviderReasoningIOSettings = {
	// include this in payload to get reasoning
	input?: { includeInPayload?: (reasoningState: SendableReasoningInfo) => null | { [key: string]: unknown } };
	// nameOfFieldInDelta: reasoning output is in response.choices[0].delta[deltaReasoningField]
	// needsManualParse: whether we must manually parse out the <think> tags
	output?:
	| { nameOfFieldInDelta?: string; needsManualParse?: undefined }
	| { nameOfFieldInDelta?: undefined; needsManualParse?: true };
};

type VoidStaticProviderInfo = { // doesn't change (not stateful)
	providerReasoningIOSettings?: ProviderReasoningIOSettings; // input/output settings around thinking (allowed to be empty) - only applied if the model supports reasoning output
	modelOptions: { [key: string]: VibeideStaticModelInfo };
	modelOptionsFallback: (modelName: string, fallbackKnownValues?: Partial<VibeideStaticModelInfo>) => (VibeideStaticModelInfo & { modelName: string; recognizedModelName: string }) | null;
};



const defaultModelOptions = {
	// Unknown model id (no registry match): must not reserve the entire window for output — that collapsed chat to ~256 tokens.
	// Refined by extensiveModelOptionsFallback for known ids, or overridesOfModel from remote catalogs / user Model Overrides.
	contextWindow: 262_144,
	reservedOutputTokenSpace: 8_192,
	cost: { input: 0, output: 0 },
	downloadable: false,
	supportsSystemMessage: 'system-role' as const,
	supportsFIM: false,
	reasoningCapabilities: false,
} as const satisfies VibeideStaticModelInfo;

// TODO!!! double check all context sizes below
// TODO!!! add openrouter common models
// TODO!!! allow user to modify capabilities and tell them if autodetected model or falling back
const openSourceModelOptions_assumingOAICompat = {
	'deepseekR1': {
		supportsFIM: false,
		supportsSystemMessage: false,
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		// https://api-docs.deepseek.com/quick_start/pricing — 64K context.
		contextWindow: 64_000, reservedOutputTokenSpace: 8_000,
	},
	// Latest DeepSeek family (V4, V4-pro, …). New default when no explicit version is given.
	// Catalog wins for known aggregators (openCodeGo/openRouter) — this is only the fallback
	// for self-hosted / unknown endpoints that don't return context_length in /v1/models.
	'deepseekV4': {
		supportsFIM: false,
		supportsSystemMessage: false, // aggregator behaviour varies; safer default
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'deepseekCoderV3': {
		supportsFIM: false,
		supportsSystemMessage: false, // unstable
		reasoningCapabilities: false,
		// V3 spec is 128K through every modern aggregator path (openCodeGo/openRouter).
		// Self-hosted Ollama variants may be smaller, but those usually override via catalog.
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'deepseekCoderV2': {
		supportsFIM: false,
		supportsSystemMessage: false, // unstable
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'codestral': {
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'devstral': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 131_000, reservedOutputTokenSpace: 8_192,
	},
	'openhands-lm-32b': { // https://www.all-hands.dev/blog/introducing-openhands-lm-32b----a-strong-open-coding-agent-model
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false, // built on qwen 2.5 32B instruct
		contextWindow: 128_000, reservedOutputTokenSpace: 4_096
	},

	// really only phi4-reasoning supports reasoning... simpler to combine them though
	'phi4': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 16_000, reservedOutputTokenSpace: 4_096,
	},

	'gemma': { // Gemma 3+ has 128K context (Gemma 1/2 had 8K, but 3 superseded those).
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	// llama 4 https://ai.meta.com/blog/llama-4-multimodal-intelligence/
	'llama4-scout': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 10_000_000, reservedOutputTokenSpace: 4_096,
	},
	'llama4-maverick': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 10_000_000, reservedOutputTokenSpace: 4_096,
	},

	// llama 3
	'llama3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 32_000, reservedOutputTokenSpace: 4_096,
	},
	'llama3.1': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		// Llama 3.1+ all support 128K context per Meta's spec.
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'llama3.2': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'llama3.3': {
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	// qwen
	'qwen2.5coder': {
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		// Qwen2.5-Coder native context: 128K.
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'qwq': {
		supportsFIM: false, // no FIM, yes reasoning
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	'qwen3': {
		supportsFIM: false, // replaces QwQ
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, openSourceThinkTags: ['<think>', '</think>'] },
		// Qwen3 series (including Qwen3-Coder) supports 128K out of the box.
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,
	},
	// FIM only
	'starcoder2': {
		supportsFIM: true,
		supportsSystemMessage: false,
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,

	},
	'codegemma:2b': {
		supportsFIM: true,
		supportsSystemMessage: false,
		reasoningCapabilities: false,
		contextWindow: 128_000, reservedOutputTokenSpace: 8_192,

	},
	'quasar': { // openrouter/quasar-alpha
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
		contextWindow: 1_000_000, reservedOutputTokenSpace: 32_000,
	}
} as const satisfies { [s: string]: Partial<VibeideStaticModelInfo> };




// keep modelName, but use the fallback's defaults
const extensiveModelOptionsFallback: VoidStaticProviderInfo['modelOptionsFallback'] = (modelName, fallbackKnownValues) => {

	const lower = modelName.toLowerCase();

	const toFallback = <T extends { [s: string]: Omit<VibeideStaticModelInfo, 'cost' | 'downloadable'> },>(obj: T, recognizedModelName: string & keyof T)
		: VibeideStaticModelInfo & { modelName: string; recognizedModelName: string } => {

		const opts = obj[recognizedModelName];
		const supportsSystemMessage = opts.supportsSystemMessage === 'separated'
			? 'system-role'
			: opts.supportsSystemMessage;

		return {
			recognizedModelName,
			modelName,
			...opts,
			supportsSystemMessage: supportsSystemMessage,
			cost: { input: 0, output: 0 },
			downloadable: false,
			...fallbackKnownValues
		};
	};

	// Gemini 3 models (latest):
	if (lower.includes('gemini-3') && lower.includes('image')) { return toFallback(geminiModelOptions, 'gemini-3-pro-image-preview'); }
	if (lower.includes('gemini-3')) { return toFallback(geminiModelOptions, 'gemini-3-pro-preview'); }
	// Gemini 2.5 models:
	if (lower.includes('gemini') && (lower.includes('2.5') || lower.includes('2-5'))) {
		if (lower.includes('pro') && !lower.includes('preview')) { return toFallback(geminiModelOptions, 'gemini-2.5-pro'); }
		return toFallback(geminiModelOptions, 'gemini-2.5-pro-preview-05-06');
	}

	// Claude 4.5 models (latest):
	if (lower.includes('claude-opus-4-5') || lower.includes('claude-4-5-opus') || (lower.includes('claude-opus') && lower.includes('4.5'))) { return toFallback(anthropicModelOptions, 'claude-opus-4-5-20251101'); }
	if (lower.includes('claude-sonnet-4-5') || lower.includes('claude-4-5-sonnet') || (lower.includes('claude-sonnet') && lower.includes('4.5'))) { return toFallback(anthropicModelOptions, 'claude-sonnet-4-5-20250929'); }
	if (lower.includes('claude-haiku-4-5') || lower.includes('claude-4-5-haiku') || (lower.includes('claude-haiku') && lower.includes('4.5'))) { return toFallback(anthropicModelOptions, 'claude-haiku-4-5-20251001'); }
	// Claude 4.1 models:
	if (lower.includes('claude-opus-4-1') || lower.includes('claude-4-1-opus') || (lower.includes('claude-opus') && lower.includes('4.1'))) { return toFallback(anthropicModelOptions, 'claude-opus-4-1-20250805'); }
	// Claude 4.0 models (legacy):
	if (lower.includes('claude-4-opus') || lower.includes('claude-opus-4')) { return toFallback(anthropicModelOptions, 'claude-opus-4-20250514'); }
	if (lower.includes('claude-4-sonnet') || lower.includes('claude-sonnet-4')) { return toFallback(anthropicModelOptions, 'claude-sonnet-4-20250514'); }
	// Claude 3.7 models
	if (lower.includes('claude-3-7') || lower.includes('claude-3.7')) { return toFallback(anthropicModelOptions, 'claude-3-7-sonnet-20250219'); }
	// Claude 3.5 models
	if (lower.includes('claude-3-5') || lower.includes('claude-3.5')) { return toFallback(anthropicModelOptions, 'claude-3-5-sonnet-20241022'); }
	// Claude 3 models (legacy)
	if (lower.includes('claude')) { return toFallback(anthropicModelOptions, 'claude-3-7-sonnet-20250219'); }

	// xAI models (check latest first):
	if (lower.includes('grok-4')) { return toFallback(xAIModelOptions, 'grok-4'); }
	if (lower.includes('grok-2') || lower.includes('grok2')) { return toFallback(xAIModelOptions, 'grok-2'); }
	if (lower.includes('grok-3') || lower.includes('grok3')) { return toFallback(xAIModelOptions, 'grok-3'); }
	if (lower.includes('grok')) { return toFallback(xAIModelOptions, 'grok-3'); }

	if (lower.includes('deepseek-r1') || lower.includes('deepseek-reasoner')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekR1'); }
	if (lower.includes('deepseek') && lower.includes('v2')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekCoderV2'); }
	if (lower.includes('deepseek') && lower.includes('v3')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekCoderV3'); }
	// `deepseek-v4*` and any unrecognised `deepseek-*` default to V4 (current generation,
	// 128K context). Before the catalog-based capabilities layer, this fallback was V3
	// with a stale 32K window — caused `deepseek-v4-pro` users to see 81% context fill
	// when the real prompt was 17K tokens. See model-stalls #001-#004.
	if (lower.includes('deepseek-v4') || lower.includes('deepseek4')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekV4'); }
	if (lower.includes('deepseek')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'deepseekV4'); }

	// MiniMax (M3 = 1M ctx, multimodal, toggleable thinking; M2 = thinking, 204k). Recognized across ANY
	// openai-compatible provider (built-in aggregators + dynamic .vibe/providers.json) so vision/reasoning/
	// tool-format come from the knowledge base, not per-model file config.
	if (lower.includes('minimax')) { return toFallback(minimaxModelOptions, /m-?3/i.test(modelName) ? 'MiniMax-M3' : 'MiniMax-M2'); }

	if (lower.includes('llama3')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3'); }
	if (lower.includes('llama3.1')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.1'); }
	if (lower.includes('llama3.2')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.2'); }
	if (lower.includes('llama3.3')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama3.3'); }
	if (lower.includes('llama') || lower.includes('scout')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout'); }
	if (lower.includes('llama') || lower.includes('maverick')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout'); }
	if (lower.includes('llama')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'llama4-scout'); }

	if (lower.includes('qwen') && lower.includes('2.5') && lower.includes('coder')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen2.5coder'); }
	if (lower.includes('qwen') && lower.includes('3')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3'); }
	if (lower.includes('qwen')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'qwen3'); }
	if (lower.includes('qwq')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'qwq'); }
	if (lower.includes('phi4')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'phi4'); }
	if (lower.includes('codestral')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'codestral'); }
	if (lower.includes('devstral')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'devstral'); }

	if (lower.includes('gemma')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'gemma'); }

	if (lower.includes('starcoder2')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'starcoder2'); }

	if (lower.includes('openhands')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'openhands-lm-32b'); } // max output uncler

	if (lower.includes('quasar') || lower.includes('quaser')) { return toFallback(openSourceModelOptions_assumingOAICompat, 'quasar'); }

	// OpenAI models (check latest first, then reasoning models, then main models):
	// GPT-5.1 series (latest):
	if (lower.includes('gpt-5.1') || (lower.includes('gpt') && lower.includes('5.1'))) { return toFallback(openAIModelOptions, 'gpt-5.1'); }
	// GPT-5 series:
	if (lower.includes('gpt-5') && lower.includes('pro')) { return toFallback(openAIModelOptions, 'gpt-5-pro'); }
	if (lower.includes('gpt-5') && lower.includes('nano')) { return toFallback(openAIModelOptions, 'gpt-5-nano'); }
	if (lower.includes('gpt-5') && lower.includes('mini')) { return toFallback(openAIModelOptions, 'gpt-5-mini'); }
	if (lower.includes('gpt-5') || (lower.includes('gpt') && lower.includes('5'))) { return toFallback(openAIModelOptions, 'gpt-5'); }
	// GPT-4.1 series:
	if (lower.includes('gpt-4.1') && lower.includes('nano')) { return toFallback(openAIModelOptions, 'gpt-4.1-nano'); }
	if (lower.includes('gpt-4.1') && lower.includes('mini')) { return toFallback(openAIModelOptions, 'gpt-4.1-mini'); }
	if (lower.includes('gpt-4.1') || (lower.includes('gpt') && lower.includes('4.1'))) { return toFallback(openAIModelOptions, 'gpt-4.1'); }
	// Reasoning models (o-series):
	if (lower.includes('o3') && lower.includes('deep') && lower.includes('search')) { return toFallback(openAIModelOptions, 'o3-deep-search'); }
	if (lower.includes('o3') && lower.includes('pro')) { return toFallback(openAIModelOptions, 'o3-pro'); }
	if (lower.includes('o3') && lower.includes('mini')) { return toFallback(openAIModelOptions, 'o3-mini'); }
	if (lower.includes('o3')) { return toFallback(openAIModelOptions, 'o3'); }
	if (lower.includes('o4') && lower.includes('mini')) { return toFallback(openAIModelOptions, 'o4-mini'); }
	if (lower.includes('o1') && lower.includes('pro')) { return toFallback(openAIModelOptions, 'o1-pro'); }
	if (lower.includes('o1') && lower.includes('mini')) { return toFallback(openAIModelOptions, 'o1-mini'); }
	if (lower.includes('o1')) { return toFallback(openAIModelOptions, 'o1'); }
	// GPT-4o series:
	if (lower.includes('gpt-4o') && lower.includes('mini')) { return toFallback(openAIModelOptions, 'gpt-4o-mini'); }
	if (lower.includes('gpt-4o') || lower.includes('4o')) { return toFallback(openAIModelOptions, 'gpt-4o'); }
	// Legacy GPT-3.5 fallback:
	if (lower.includes('gpt') && (lower.includes('3.5') || lower.includes('turbo'))) { return toFallback(openAIModelOptions, 'gpt-4o-mini'); }


	if (Object.keys(openSourceModelOptions_assumingOAICompat).map(k => k.toLowerCase()).includes(lower)) { return toFallback(openSourceModelOptions_assumingOAICompat, lower as keyof typeof openSourceModelOptions_assumingOAICompat); }

	return null;
};






// ---------------- ANTHROPIC ----------------
// Reference: https://platform.claude.com/docs/en/about-claude/models/overview (checked 2025-11-30)
const anthropicModelOptions = {
	// Latest Claude 4.5 series:
	'claude-opus-4-5-20251101': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 15.00, cache_read: 1.50, cache_write: 18.75, output: 30.00 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 },
		},
	},
	'claude-sonnet-4-5-20250929': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 3.00, cache_read: 0.30, cache_write: 3.75, output: 6.00 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 },
		},
	},
	'claude-haiku-4-5-20251001': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.80, cache_read: 0.08, cache_write: 1.00, output: 4.00 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-opus-4-1-20250805': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 15.00, cache_read: 1.50, cache_write: 18.75, output: 30.00 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 },
		},
	},
	// Claude 3.7 series:
	'claude-3-7-sonnet-20250219': { // https://docs.anthropic.com/en/docs/about-claude/models/all-models#model-comparison-table
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 3.00, cache_read: 0.30, cache_write: 3.75, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192, // can bump it to 128_000 with beta mode output-128k-2025-02-19
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000. we cap at 8192 because above is typically not necessary (often even buggy)
		},

	},
	// Legacy Claude 4.0 series (still available):
	'claude-opus-4-20250514': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 15.00, cache_read: 1.50, cache_write: 18.75, output: 30.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192, // can bump it to 128_000 with beta mode output-128k-2025-02-19
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000. we cap at 8192 because above is typically not necessary (often even buggy)
		},

	},
	'claude-sonnet-4-20250514': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 3.00, cache_read: 0.30, cache_write: 3.75, output: 6.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192, // can bump it to 128_000 with beta mode output-128k-2025-02-19
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000. we cap at 8192 because above is typically not necessary (often even buggy)
		},

	},
	'claude-3-5-sonnet-20241022': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 3.00, cache_read: 0.30, cache_write: 3.75, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-5-haiku-20241022': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.80, cache_read: 0.08, cache_write: 1.00, output: 4.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-opus-20240229': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 15.00, cache_read: 1.50, cache_write: 18.75, output: 75.00 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	},
	'claude-3-sonnet-20240229': { // no point of using this, but including this for people who put it in
		contextWindow: 200_000, cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		reservedOutputTokenSpace: 4_096,
		supportsFIM: false,
		specialToolFormat: 'anthropic-style',
		supportsSystemMessage: 'separated',
		reasoningCapabilities: false,
	}
} as const satisfies { [s: string]: VibeideStaticModelInfo };

const anthropicSettings: VoidStaticProviderInfo = {
	providerReasoningIOSettings: {
		input: {
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo?.isReasoningEnabled) { return null; }

				if (reasoningInfo.type === 'budget_slider_value') {
					return { thinking: { type: 'enabled', budget_tokens: reasoningInfo.reasoningBudget } };
				}
				return null;
			}
		},
	},
	modelOptions: anthropicModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase();
		let fallbackName: keyof typeof anthropicModelOptions | null = null;
		// Claude 4.5 models (latest):
		if (lower.includes('claude-opus-4-5') || lower.includes('claude-4-5-opus') || (lower.includes('claude-opus') && lower.includes('4.5'))) { fallbackName = 'claude-opus-4-5-20251101'; }
		if (lower.includes('claude-sonnet-4-5') || lower.includes('claude-4-5-sonnet') || (lower.includes('claude-sonnet') && lower.includes('4.5'))) { fallbackName = 'claude-sonnet-4-5-20250929'; }
		if (lower.includes('claude-haiku-4-5') || lower.includes('claude-4-5-haiku') || (lower.includes('claude-haiku') && lower.includes('4.5'))) { fallbackName = 'claude-haiku-4-5-20251001'; }
		// Claude 4.1 models:
		if (lower.includes('claude-opus-4-1') || lower.includes('claude-4-1-opus') || (lower.includes('claude-opus') && lower.includes('4.1'))) { fallbackName = 'claude-opus-4-1-20250805'; }
		// Claude 4.0 models (legacy):
		if (lower.includes('claude-4-opus') || lower.includes('claude-opus-4') || lower.includes('claude-opus-4-0')) { fallbackName = 'claude-opus-4-20250514'; }
		if (lower.includes('claude-4-sonnet') || lower.includes('claude-sonnet-4') || lower.includes('claude-sonnet-4-0')) { fallbackName = 'claude-sonnet-4-20250514'; }
		// Claude 3.7 models
		if (lower.includes('claude-3-7-sonnet') || lower.includes('claude-3-7-sonnet-latest')) { fallbackName = 'claude-3-7-sonnet-20250219'; }
		// Claude 3.5 models
		if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3-5-sonnet-latest')) { fallbackName = 'claude-3-5-sonnet-20241022'; }
		if (lower.includes('claude-3-5-haiku') || lower.includes('claude-3-5-haiku-latest')) { fallbackName = 'claude-3-5-haiku-20241022'; }
		// Claude 3 models (legacy)
		if (lower.includes('claude-3-opus') || lower.includes('claude-3-opus-latest')) { fallbackName = 'claude-3-opus-20240229'; }
		if (lower.includes('claude-3-sonnet') || lower.includes('claude-3-sonnet-latest')) { fallbackName = 'claude-3-sonnet-20240229'; }
		if (fallbackName) { return { modelName: fallbackName, recognizedModelName: fallbackName, ...anthropicModelOptions[fallbackName] }; }
		return null;
	},
};


// ---------------- OPENAI ----------------
// NOTE: Keep this list in sync with OpenAI's current "production" models.
// When adding a new model, make sure routing/risk policies are updated.
// Reference: https://platform.openai.com/docs/models (checked 2025-11-30)
const openAIModelOptions = { // https://platform.openai.com/docs/pricing
	// Latest GPT-5 series (best for coding and agentic tasks):
	'gpt-5.1': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 2.50, output: 10.00, cache_read: 0.625 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'gpt-5': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 2.50, output: 10.00, cache_read: 0.625 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'gpt-5-mini': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.50, output: 2.00, cache_read: 0.125 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'gpt-5-nano': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.10, output: 0.40, cache_read: 0.03 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'gpt-5-pro': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 5.00, output: 20.00, cache_read: 1.25 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	// GPT-4.1 series (smartest non-reasoning models):
	'gpt-4.1': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 2.00, output: 8.00, cache_read: 0.50 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'gpt-4.1-mini': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.40, output: 1.60, cache_read: 0.10 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	'gpt-4.1-nano': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 0.10, output: 0.40, cache_read: 0.03 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: false,
	},
	// GPT-4o series (fast, intelligent, flexible):
	'gpt-4o': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 16_384,
		cost: { input: 2.50, cache_read: 1.25, output: 10.00, },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'gpt-4o-mini': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 16_384,
		cost: { input: 0.15, cache_read: 0.075, output: 0.60, },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	// Reasoning models (o-series):
	'o3-deep-search': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 20.00, output: 80.00, cache_read: 5.00 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o3-pro': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 15.00, output: 60.00, cache_read: 3.75 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o3': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 10.00, output: 40.00, cache_read: 2.50 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o3-mini': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: 100_000,
		cost: { input: 1.10, cache_read: 0.55, output: 4.40, },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o4-mini': {
		contextWindow: 1_047_576, // TODO: Verify actual context window
		reservedOutputTokenSpace: 32_768,
		cost: { input: 1.10, output: 4.40, cache_read: 0.275 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o1-pro': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 100_000,
		cost: { input: 20.00, cache_read: 10.00, output: 80.00, }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o1': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 100_000,
		cost: { input: 15.00, cache_read: 7.50, output: 60.00, },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'developer-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	'o1-mini': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 65_536,
		cost: { input: 1.10, cache_read: 0.55, output: 4.40, },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: false, // does not support any system
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'medium', 'high'], default: 'low' } },
	},
	// Legacy models (still available for backward compatibility):
	// 'gpt-3.5-turbo': // Legacy chat model, not recommended for new usage
} as const satisfies { [s: string]: VibeideStaticModelInfo };


// https://platform.openai.com/docs/guides/reasoning?api-mode=chat
const openAICompatIncludeInPayloadReasoning = (reasoningInfo: SendableReasoningInfo) => {
	if (!reasoningInfo?.isReasoningEnabled) { return null; }
	if (reasoningInfo.type === 'effort_slider_value') {
		return { reasoning_effort: reasoningInfo.reasoningEffort };
	}
	return null;

};

const openAISettings: VoidStaticProviderInfo = {
	modelOptions: openAIModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase();
		let fallbackName: keyof typeof openAIModelOptions | null = null;
		// GPT-5.1 series (latest, check first):
		if (lower.includes('gpt-5.1') || (lower.includes('gpt') && lower.includes('5.1'))) { fallbackName = 'gpt-5.1'; }
		// GPT-5 series:
		if (lower.includes('gpt-5') && lower.includes('pro')) { fallbackName = 'gpt-5-pro'; }
		if (lower.includes('gpt-5') && lower.includes('nano')) { fallbackName = 'gpt-5-nano'; }
		if (lower.includes('gpt-5') && lower.includes('mini')) { fallbackName = 'gpt-5-mini'; }
		if (lower.includes('gpt-5') || (lower.includes('gpt') && lower.includes('5'))) { fallbackName = 'gpt-5'; }
		// GPT-4.1 series:
		if (lower.includes('gpt-4.1') && lower.includes('nano')) { fallbackName = 'gpt-4.1-nano'; }
		if (lower.includes('gpt-4.1') && lower.includes('mini')) { fallbackName = 'gpt-4.1-mini'; }
		if (lower.includes('gpt-4.1') || (lower.includes('gpt') && lower.includes('4.1'))) { fallbackName = 'gpt-4.1'; }
		// Reasoning models (o-series, check before GPT-4o):
		if (lower.includes('o3') && lower.includes('deep') && lower.includes('search')) { fallbackName = 'o3-deep-search'; }
		if (lower.includes('o3') && lower.includes('pro')) { fallbackName = 'o3-pro'; }
		if (lower.includes('o3') && lower.includes('mini')) { fallbackName = 'o3-mini'; }
		if (lower.includes('o3')) { fallbackName = 'o3'; }
		if (lower.includes('o4') && lower.includes('mini')) { fallbackName = 'o4-mini'; }
		if (lower.includes('o1') && lower.includes('pro')) { fallbackName = 'o1-pro'; }
		if (lower.includes('o1') && lower.includes('mini')) { fallbackName = 'o1-mini'; }
		if (lower.includes('o1')) { fallbackName = 'o1'; }
		// GPT-4o series:
		if (lower.includes('gpt-4o') && lower.includes('mini')) { fallbackName = 'gpt-4o-mini'; }
		if (lower.includes('gpt-4o') || lower.includes('4o')) { fallbackName = 'gpt-4o'; }
		// Legacy models:
		if (lower.includes('gpt-3.5') || lower.includes('3.5-turbo')) {
			// Fallback to gpt-4o-mini for legacy 3.5-turbo requests
			fallbackName = 'gpt-4o-mini';
		}
		if (fallbackName) { return { modelName: fallbackName, recognizedModelName: fallbackName, ...openAIModelOptions[fallbackName] }; }
		return null;
	},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
};

// ---------------- XAI ----------------
const xAIModelOptions = {
	// https://docs.x.ai/docs/guides/reasoning#reasoning
	// https://docs.x.ai/docs/models#models-and-pricing
	// Reference: https://docs.x.ai/docs/models (checked 2025-11-30)
	'grok-4': {
		contextWindow: 131_072, // TODO: Verify actual context window
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false, // TODO: Verify if grok-4 supports reasoning
	},
	'grok-3': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	'grok-3-fast': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 5.00, output: 25.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
	// only mini supports thinking
	'grok-3-mini': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 0.30, output: 0.50 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
	'grok-3-mini-fast': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 0.60, output: 4.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false, reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
	'grok-2': {
		contextWindow: 131_072,
		reservedOutputTokenSpace: null,
		cost: { input: 2.00, output: 10.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VibeideStaticModelInfo };

const xAISettings: VoidStaticProviderInfo = {
	modelOptions: xAIModelOptions,
	modelOptionsFallback: (modelName) => {
		const lower = modelName.toLowerCase();
		let fallbackName: keyof typeof xAIModelOptions | null = null;
		// Check latest first:
		if (lower.includes('grok-4')) { fallbackName = 'grok-4'; }
		if (lower.includes('grok-2')) { fallbackName = 'grok-2'; }
		if (lower.includes('grok-3')) { fallbackName = 'grok-3'; }
		if (lower.includes('grok')) { fallbackName = 'grok-3'; }
		if (fallbackName) { return { modelName: fallbackName, recognizedModelName: fallbackName, ...xAIModelOptions[fallbackName] }; }
		return null;
	},
	// same implementation as openai
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
};


// ---------------- GEMINI ----------------
const geminiModelOptions = { // https://ai.google.dev/gemini-api/docs/pricing
	// https://ai.google.dev/gemini-api/docs/thinking#set-budget
	// Latest Gemini 3 series (preview):
	'gemini-3-pro-preview': {
		contextWindow: 1_048_576, // 1M tokens input
		reservedOutputTokenSpace: 65_536, // 65K tokens output
		cost: { input: 0, output: 0 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false, // TODO: Verify if Gemini 3 supports reasoning
	},
	'gemini-3-pro-image-preview': {
		contextWindow: 1_048_576, // 1M tokens input
		reservedOutputTokenSpace: 65_536, // 65K tokens output
		cost: { input: 0, output: 0 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false, // TODO: Verify if Gemini 3 supports reasoning
	},
	// Gemini 2.5 series:
	'gemini-2.5-pro': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 }, // TODO: Verify pricing
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.5-pro-preview-05-06': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.0-flash-lite': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false, // no reasoning
	},
	'gemini-2.5-flash-preview-04-17': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.15, output: .60 }, // TODO $3.50 output with thinking not included
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.5-pro-exp-03-25': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: false,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // max is really 24576
			reasoningReservedOutputTokenSpace: 8192,
		},
	},
	'gemini-2.0-flash': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192, // 8_192,
		cost: { input: 0.10, output: 0.40 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-2.0-flash-lite-preview-02-05': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192, // 8_192,
		cost: { input: 0.075, output: 0.30 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-1.5-flash': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192, // 8_192,
		cost: { input: 0.075, output: 0.30 },  // TODO!!! price doubles after 128K tokens, we are NOT encoding that info right now
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-1.5-pro': {
		contextWindow: 2_097_152,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 1.25, output: 5.00 },  // TODO!!! price doubles after 128K tokens, we are NOT encoding that info right now
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
	'gemini-1.5-flash-8b': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.0375, output: 0.15 },  // TODO!!! price doubles after 128K tokens, we are NOT encoding that info right now
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'separated',
		specialToolFormat: 'gemini-style',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VibeideStaticModelInfo };

const geminiSettings: VoidStaticProviderInfo = {
	modelOptions: geminiModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
};



// ---------------- DEEPSEEK API ----------------
const deepseekModelOptions = {
	'deepseek-chat': {
		...openSourceModelOptions_assumingOAICompat.deepseekR1,
		contextWindow: 64_000, // https://api-docs.deepseek.com/quick_start/pricing
		reservedOutputTokenSpace: 8_000, // 8_000,
		cost: { cache_read: .07, input: .27, output: 1.10, },
		downloadable: false,
	},
	'deepseek-reasoner': {
		...openSourceModelOptions_assumingOAICompat.deepseekCoderV2,
		contextWindow: 64_000,
		reservedOutputTokenSpace: 8_000, // 8_000,
		cost: { cache_read: .14, input: .55, output: 2.19, },
		downloadable: false,
	},
} as const satisfies { [s: string]: VibeideStaticModelInfo };


const deepseekSettings: VoidStaticProviderInfo = {
	modelOptions: deepseekModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
	providerReasoningIOSettings: {
		// reasoning: OAICompat +  response.choices[0].delta.reasoning_content // https://api-docs.deepseek.com/guides/reasoning_model
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};



// ---------------- MISTRAL ----------------

const mistralModelOptions = { // https://mistral.ai/products/la-plateforme#pricing https://docs.mistral.ai/getting-started/models/models_overview/#premier-models
	'mistral-large-latest': {
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 2.00, output: 6.00 },
		supportsFIM: true,
		downloadable: { sizeGb: 73 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'mistral-medium-latest': { // https://openrouter.ai/mistralai/mistral-medium-3
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.40, output: 2.00 },
		supportsFIM: true,
		downloadable: { sizeGb: 'not-known' },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'codestral-latest': {
		contextWindow: 256_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.30, output: 0.90 },
		supportsFIM: true,
		downloadable: { sizeGb: 13 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'magistral-medium-latest': {
		contextWindow: 256_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.30, output: 0.90 }, // TODO: check this
		supportsFIM: true,
		downloadable: { sizeGb: 13 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'magistral-small-latest': {
		contextWindow: 40_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.30, output: 0.90 }, // TODO: check this
		supportsFIM: true,
		downloadable: { sizeGb: 13 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'devstral-small-latest': { //https://openrouter.ai/mistralai/devstral-small:free
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		supportsFIM: false,
		downloadable: { sizeGb: 14 }, //https://ollama.com/library/devstral
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'ministral-8b-latest': { // ollama 'mistral'
		contextWindow: 131_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 0.10, output: 0.10 },
		supportsFIM: false,
		downloadable: { sizeGb: 4.1 },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'ministral-3b-latest': {
		contextWindow: 131_000,
		reservedOutputTokenSpace: 4_096,
		cost: { input: 0.04, output: 0.04 },
		supportsFIM: false,
		downloadable: { sizeGb: 'not-known' },
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
} as const satisfies { [s: string]: VibeideStaticModelInfo };

const mistralSettings: VoidStaticProviderInfo = {
	modelOptions: mistralModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
};


// ---------------- GROQ ----------------
const groqModelOptions = { // https://console.groq.com/docs/models, https://groq.com/pricing/
	'llama-3.3-70b-versatile': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 32_768, // 32_768,
		cost: { input: 0.59, output: 0.79 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'llama-3.1-8b-instant': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0.05, output: 0.08 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen-2.5-coder-32b': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null, // not specified?
		cost: { input: 0.79, output: 0.79 },
		downloadable: false,
		supportsFIM: false, // unfortunately looks like no FIM support on groq
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'qwen-qwq-32b': { // https://huggingface.co/Qwen/QwQ-32B
		contextWindow: 128_000,
		reservedOutputTokenSpace: null, // not specified?
		cost: { input: 0.29, output: 0.39 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] }, // we're using reasoning_format:parsed so really don't need to know openSourceThinkTags
	},
} as const satisfies { [s: string]: VibeideStaticModelInfo };
const groqSettings: VoidStaticProviderInfo = {
	modelOptions: groqModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
	providerReasoningIOSettings: {
		// Must be set to either parsed or hidden when using tool calling https://console.groq.com/docs/reasoning
		input: {
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo?.isReasoningEnabled) { return null; }
				if (reasoningInfo.type === 'budget_slider_value') {
					return { reasoning_format: 'parsed' };
				}
				return null;
			}
		},
		output: { nameOfFieldInDelta: 'reasoning' },
	},
};


// ---------------- GOOGLE VERTEX ----------------
const googleVertexModelOptions = {
} as const satisfies Record<string, VibeideStaticModelInfo>;
const googleVertexSettings: VoidStaticProviderInfo = {
	modelOptions: googleVertexModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
};

// ---------------- MICROSOFT AZURE ----------------
const microsoftAzureModelOptions = {
} as const satisfies Record<string, VibeideStaticModelInfo>;
const microsoftAzureSettings: VoidStaticProviderInfo = {
	modelOptions: microsoftAzureModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
};

// ---------------- AWS BEDROCK ----------------
const awsBedrockModelOptions = {
} as const satisfies Record<string, VibeideStaticModelInfo>;

const awsBedrockSettings: VoidStaticProviderInfo = {
	modelOptions: awsBedrockModelOptions,
	modelOptionsFallback: (modelName) => { return null; },
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
	},
};


// ---------------- VLLM, OLLAMA, OPENAICOMPAT (self-hosted / local) ----------------
const ollamaModelOptions = {
	'qwen2.5-coder:7b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 1.9 },
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: false,
	},
	'qwen2.5-coder:3b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 1.9 },
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: false,
	},
	'qwen2.5-coder:1.5b': {
		contextWindow: 32_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: .986 },
		supportsFIM: true,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: false,
	},
	'llama3.1': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.9 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: false,
	},
	'qwen2.5-coder': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.7 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: false,
	},
	'qwq': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: 32_000,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 20 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: false, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'deepseek-r1': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 4.7 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: false, canTurnOffReasoning: false, openSourceThinkTags: ['<think>', '</think>'] },
	},
	'devstral:latest': {
		contextWindow: 131_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: { sizeGb: 14 },
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		specialToolFormat: 'openai-style', // Ollama is OpenAI-compatible and supports tool calling
		reasoningCapabilities: false,
	},

} as const satisfies Record<string, VibeideStaticModelInfo>;

export const ollamaRecommendedModels = ['qwen2.5-coder:1.5b', 'llama3.1', 'qwq', 'deepseek-r1', 'devstral:latest'] as const satisfies (keyof typeof ollamaModelOptions)[];


const vLLMSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => {
		const fallback = extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } });
		// vLLM is OpenAI-compatible, so all models should support tool calling via OpenAI-style format
		if (fallback && !fallback.specialToolFormat) {
			fallback.specialToolFormat = 'openai-style';
		}
		return fallback;
	},
	modelOptions: {},
	providerReasoningIOSettings: {
		// reasoning: OAICompat + response.choices[0].delta.reasoning_content // https://docs.vllm.ai/en/stable/features/reasoning_outputs.html#streaming-chat-completions
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};

const lmStudioSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => {
		const fallback = extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' }, contextWindow: 4_096 });
		// LM Studio is OpenAI-compatible, so all models should support tool calling via OpenAI-style format
		if (fallback && !fallback.specialToolFormat) {
			fallback.specialToolFormat = 'openai-style';
		}
		return fallback;
	},
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { needsManualParse: true },
	},
};

const ollamaSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: (modelName) => {
		const fallback = extensiveModelOptionsFallback(modelName, { downloadable: { sizeGb: 'not-known' } });
		// Ollama is OpenAI-compatible, so all models should support tool calling via OpenAI-style format
		if (fallback && !fallback.specialToolFormat) {
			fallback.specialToolFormat = 'openai-style';
		}
		return fallback;
	},
	modelOptions: ollamaModelOptions,
	providerReasoningIOSettings: {
		// reasoning: we need to filter out reasoning <think> tags manually
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { needsManualParse: true },
	},
};

/**
 * Universal modelOptionsFallback for OpenAI-compatible aggregator providers
 * (openCodeGo, openCodeZen, openRouter, liteLLM, lmRoute, openAICompatible,
 * pollinations). Aggregators proxy any model behind an OpenAI-compatible
 * `/chat/completions` endpoint and almost universally support OpenAI tools
 * format — so unrecognized models (yesterday's minimax, tomorrow's maximax)
 * should default to native function-calling, not XML-in-prompt.
 *
 * Returns a synthesized fallback for completely unknown models so that
 * `specialToolFormat='openai-style'` is set even when the model id matches
 * none of `extensiveModelOptionsFallback`'s known families. Without this
 * helper, unknown models fell through to `defaultModelOptions` which has
 * no `specialToolFormat`, forcing the model into XML-in-prompt mode where
 * it routinely hallucinates tag formats (<bash>, <invoke>, <workspace_read>,
 * <minimax:tool_call>, etc.) that we then have to chase in the parser.
 *
 * Set `vibeide.llm.assumeNativeTools=false` to opt out (forces XML-in-prompt
 * for misbehaving aggregators where native tools fail with HTTP 4xx).
 */
const aggregatorOpenAIFallback: VoidStaticProviderInfo['modelOptionsFallback'] = (modelName, fallbackKnownValues) => {
	// No hardcoded substring-detection here. Model-quirks (numeric tool names,
	// missing required fields) are handled at runtime by per-(provider×model)
	// auto-downgrade in chatThreadService.runMessageLoop — see roadmap O.0–O.7
	// (Tool-call resilience). Default for unknown aggregator model: opt into
	// native function-calling, then downgrade based on observed behaviour.
	const fromExtensive = extensiveModelOptionsFallback(modelName, fallbackKnownValues);
	if (fromExtensive) {
		if (!fromExtensive.specialToolFormat) { fromExtensive.specialToolFormat = 'openai-style'; }
		return fromExtensive;
	}
	// Unknown model on an OpenAI-compatible aggregator — synthesize a generic
	// fallback that opts into native tools by default. Vendor-locked fields
	// (cost, downloadable) come from defaultModelOptions; the synthesized
	// recognizedModelName makes it visible in logs that this is a guess.
	return {
		recognizedModelName: '__aggregator_unknown__',
		modelName,
		...defaultModelOptions,
		specialToolFormat: 'openai-style',
		...(fallbackKnownValues ?? {}),
	};
};

const openaiCompatible: VoidStaticProviderInfo = {
	modelOptionsFallback: aggregatorOpenAIFallback,
	modelOptions: {},
	providerReasoningIOSettings: {
		// reasoning: we have no idea what endpoint they used, so we can't consistently parse out reasoning
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};

const liteLLMSettings: VoidStaticProviderInfo = { // https://docs.litellm.ai/docs/reasoning_content
	modelOptionsFallback: (modelName) => aggregatorOpenAIFallback(modelName, { downloadable: { sizeGb: 'not-known' } }),
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};

const lmRouteSettings: VoidStaticProviderInfo = { // OpenAI-compatible aggregator (lmrouter.com / self-hosted)
	modelOptionsFallback: (modelName) => aggregatorOpenAIFallback(modelName, { downloadable: { sizeGb: 'not-known' } }),
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};

// ---------------- OPENCODE ZEN ----------------
// Model ids: https://opencode.ai/zen/v1/models — sync via RemoteCatalogService (refresh catalog in settings).
// Context limits: catalog entries may expose context_length in the future; until then, ids like gpt-5.1 / glm-5.1 match extensiveModelOptionsFallback; others use aggregator fallback (assumes openai-style tools).
const openCodeZenSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: aggregatorOpenAIFallback,
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};

// ---------------- OPENCODE (GO) ----------------
const openCodeSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: aggregatorOpenAIFallback,
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};

// ---------------- POLLINATIONS ----------------
const pollinationsSettings: VoidStaticProviderInfo = {
	modelOptionsFallback: aggregatorOpenAIFallback,
	modelOptions: {},
	providerReasoningIOSettings: {
		input: { includeInPayload: openAICompatIncludeInPayloadReasoning },
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};


// ---------------- OPENROUTER ----------------
const openRouterModelOptions_assumingOpenAICompat = {
	'qwen/qwen3-235b-a22b': {
		contextWindow: 40_960,
		reservedOutputTokenSpace: null,
		cost: { input: .10, output: .10 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false },
	},
	'microsoft/phi-4-reasoning-plus:free': { // a 14B model...
		contextWindow: 32_768,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canIOReasoning: true, canTurnOffReasoning: false },
	},
	'mistralai/mistral-small-3.1-24b-instruct:free': {
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'google/gemini-2.0-flash-lite-preview-02-05:free': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'google/gemini-2.0-pro-exp-02-05:free': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'google/gemini-2.0-flash-exp:free': {
		contextWindow: 1_048_576,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'deepseek/deepseek-r1': {
		...openSourceModelOptions_assumingOAICompat.deepseekR1,
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.8, output: 2.4 },
		downloadable: false,
	},
	'deepseek/deepseek-r1-zero:free': {
		...openSourceModelOptions_assumingOAICompat.deepseekR1,
		contextWindow: 128_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
	},
	'anthropic/claude-opus-4': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 15.00, output: 30.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 },
		},
	},
	'anthropic/claude-sonnet-4': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 6.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: {
			supportsReasoning: true,
			canTurnOffReasoning: true,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 },
		},
	},
	'anthropic/claude-3.7-sonnet:thinking': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { // same as anthropic, see above
			supportsReasoning: true,
			canTurnOffReasoning: false,
			canIOReasoning: true,
			reasoningReservedOutputTokenSpace: 8192,
			reasoningSlider: { type: 'budget_slider', min: 1024, max: 8192, default: 1024 }, // they recommend batching if max > 32_000.
		},
	},
	'anthropic/claude-3.7-sonnet': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false, // stupidly, openrouter separates thinking from non-thinking
	},
	'anthropic/claude-3.5-sonnet': {
		contextWindow: 200_000,
		reservedOutputTokenSpace: null,
		cost: { input: 3.00, output: 15.00 },
		downloadable: false,
		supportsFIM: false,
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: false,
	},
	'mistralai/codestral-2501': {
		...openSourceModelOptions_assumingOAICompat.codestral,
		contextWindow: 256_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.3, output: 0.9 },
		downloadable: false,
		reasoningCapabilities: false,
	},
	'mistralai/devstral-small:free': {
		...openSourceModelOptions_assumingOAICompat.devstral,
		contextWindow: 130_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0, output: 0 },
		downloadable: false,
		reasoningCapabilities: false,
	},
	'qwen/qwen-2.5-coder-32b-instruct': {
		...openSourceModelOptions_assumingOAICompat['qwen2.5coder'],
		contextWindow: 33_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.07, output: 0.16 },
		downloadable: false,
	},
	'qwen/qwq-32b': {
		...openSourceModelOptions_assumingOAICompat['qwq'],
		contextWindow: 33_000,
		reservedOutputTokenSpace: null,
		cost: { input: 0.07, output: 0.16 },
		downloadable: false,
	}
} as const satisfies { [s: string]: VibeideStaticModelInfo };

const openRouterSettings: VoidStaticProviderInfo = {
	modelOptions: openRouterModelOptions_assumingOpenAICompat,
	modelOptionsFallback: (modelName) => {
		const res = aggregatorOpenAIFallback(modelName);
		// openRouter does not support gemini-style, use openai-style instead
		if (res?.specialToolFormat === 'gemini-style') {
			res.specialToolFormat = 'openai-style';
		}
		return res;
	},
	providerReasoningIOSettings: {
		// reasoning: OAICompat + response.choices[0].delta.reasoning : payload should have {include_reasoning: true} https://openrouter.ai/announcements/reasoning-tokens-for-thinking-models
		input: {
			// https://openrouter.ai/docs/use-cases/reasoning-tokens
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo?.isReasoningEnabled) { return null; }

				if (reasoningInfo.type === 'budget_slider_value') {
					return {
						reasoning: {
							max_tokens: reasoningInfo.reasoningBudget
						}
					};
				}
				if (reasoningInfo.type === 'effort_slider_value') {
					return {
						reasoning: {
							effort: reasoningInfo.reasoningEffort
						}
					};
				}
				return null;
			}
		},
		output: { nameOfFieldInDelta: 'reasoning' },
	},
};



// ---------------- MINIMAX ----------------
// Direct cloud, OpenAI-compatible. Base URL https://api.minimax.io/v1.
// Standard direct-provider profile (same shape as deepseek/openAI): accurate
// context window + reasoning metadata, no problematic-model workarounds.
// MiniMax-M2 is a thinking model (interleaved, always on) that streams its
// chain-of-thought in `reasoning_content`. Context spec: 204,800 tokens.
// Reference: https://platform.minimax.io/docs/api-reference/text-chat-openai
const minimaxModelOptions = {
	// M3: 1M-token context (MSA architecture), toggleable interleaved thinking, native
	// multimodality. Ref: https://www.minimax.io/models/text/m3
	'MiniMax-M3': {
		contextWindow: 1_000_000,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 }, // informational only; not used for routing
		downloadable: false,
		supportsFIM: false,
		supportsVision: true,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: true, canIOReasoning: true, stripThinkTagsFromContent: ['<think>', '</think>'], reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
	'MiniMax-M2': {
		contextWindow: 204_800,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 }, // informational only; not used for routing
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, stripThinkTagsFromContent: ['<think>', '</think>'], reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
	'MiniMax-M2-Stable': {
		contextWindow: 204_800,
		reservedOutputTokenSpace: 8_192,
		cost: { input: 0, output: 0 },
		downloadable: false,
		supportsFIM: false,
		specialToolFormat: 'openai-style',
		supportsSystemMessage: 'system-role',
		reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: true, stripThinkTagsFromContent: ['<think>', '</think>'], reasoningSlider: { type: 'effort_slider', values: ['low', 'high'], default: 'low' } },
	},
} as const satisfies { [s: string]: VibeideStaticModelInfo };

const minimaxSettings: VoidStaticProviderInfo = {
	modelOptions: minimaxModelOptions,
	// Recognise the generation so an unlisted id gets the right profile: `m3` → 1M-context
	// M3 profile; everything else (M2, M2.x, …) → the M2 profile. The catalog (/v1/models)
	// still wins for an exact id.
	modelOptionsFallback: (modelName) => {
		const recognized = /m-?3/i.test(modelName) ? 'MiniMax-M3' : 'MiniMax-M2';
		return { modelName, recognizedModelName: recognized, ...minimaxModelOptions[recognized] };
	},
	providerReasoningIOSettings: {
		// Input: when reasoning is OFF, MiniMax-M3 disables thinking via `thinking:{type:disabled}`;
		// when ON, the effort slider maps to `reasoning_effort: 'low'|'high'`.
		input: {
			includeInPayload: (reasoningInfo) => {
				if (!reasoningInfo) { return null; }
				if (!reasoningInfo.isReasoningEnabled) { return { thinking: { type: 'disabled' } }; }
				if (reasoningInfo.type === 'effort_slider_value') { return { reasoning_effort: reasoningInfo.reasoningEffort }; }
				return null;
			},
		},
		// Output: MiniMax-M3 emits a NATIVE reasoning channel — `reasoning_content` delta (mapped
		// to AI-SDK `reasoning-delta`). That is the authoritative reasoning source → fold + export.
		// It ALSO duplicates the same text as inline `<think>…</think>` in `content`; that duplicate
		// is stripped (not re-routed) via the model's `stripThinkTagsFromContent` so it never leaks
		// into the answer body and the native reasoning is never clobbered.
		output: { nameOfFieldInDelta: 'reasoning_content' },
	},
};


// ---------------- model settings of everything above ----------------

const modelSettingsOfProvider: { [providerName in ProviderName]: VoidStaticProviderInfo } = {
	openAI: openAISettings,
	anthropic: anthropicSettings,
	xAI: xAISettings,
	gemini: geminiSettings,

	// open source models
	deepseek: deepseekSettings,
	groq: groqSettings,

	// open source models + providers (mixture of everything)
	openRouter: openRouterSettings,
	vLLM: vLLMSettings,
	ollama: ollamaSettings,
	openAICompatible: openaiCompatible,
	mistral: mistralSettings,

	liteLLM: liteLLMSettings,
	lmRoute: lmRouteSettings,
	lmStudio: lmStudioSettings,

	pollinations: pollinationsSettings,
	openCodeZen: openCodeZenSettings,
	openCodeGo: openCodeSettings,
	minimax: minimaxSettings,

	googleVertex: googleVertexSettings,
	microsoftAzure: microsoftAzureSettings,
	awsBedrock: awsBedrockSettings,
} as const;


// ---------------- runtime provider registry (built-in + external file/network providers) ----------------

/**
 * Where a provider comes from. `builtin` = compiled into VibeIDE; `file` = `.vibe/providers.json`;
 * `network` = reserved for a future remote source. The tag is metadata — every consumer resolves
 * providers through ONE path (`resolveProvider`); the tag only drives visual grouping in the UI.
 */
export type ProviderSource = 'builtin' | 'file' | 'network';

/**
 * Minimal descriptor an external source hands to the registry. The registry builds a full
 * `VoidStaticProviderInfo` for it as an OpenAI-compatible provider — so its models resolve through the
 * SAME name-recognition (`aggregatorOpenAIFallback` → `extensiveModelOptionsFallback`) as built-in
 * aggregators. `modelCapOverrides` are per-model partial caps (from a file `static` list) overlaid on
 * the recognized baseline.
 */
export type ExternalProviderDescriptor = {
	id: string;
	source: 'file' | 'network';
	modelCapOverrides?: { [modelId: string]: Partial<VibeideStaticModelInfo> };
};

const _externalProviders = new Map<string, { info: VoidStaticProviderInfo; source: 'file' | 'network' }>();

const buildExternalProviderInfo = (d: ExternalProviderDescriptor): VoidStaticProviderInfo => {
	const modelOptions: { [key: string]: VibeideStaticModelInfo } = {};
	for (const [modelId, partial] of Object.entries(d.modelCapOverrides ?? {})) {
		// Recognized baseline for the exact id (vision/reasoning/tool-format/context), then the file's
		// curated partial caps win on top.
		const baseline: VibeideStaticModelInfo = aggregatorOpenAIFallback(modelId) ?? defaultModelOptions;
		modelOptions[modelId] = { ...baseline, ...partial };
	}
	return {
		providerReasoningIOSettings: openaiCompatible.providerReasoningIOSettings,
		modelOptions,
		modelOptionsFallback: aggregatorOpenAIFallback,
	};
};

/** Replace the full set of external providers (called by the dynamic-providers service on each reload). */
export const setExternalProviders = (descriptors: readonly ExternalProviderDescriptor[]): void => {
	_externalProviders.clear();
	for (const d of descriptors) {
		_externalProviders.set(d.id, { info: buildExternalProviderInfo(d), source: d.source });
	}
};

/** Resolve a provider's static info + source — built-in OR registered external — through ONE path. */
export const resolveProvider = (providerName: string): { info: VoidStaticProviderInfo; source: ProviderSource } | undefined => {
	if (Object.prototype.hasOwnProperty.call(modelSettingsOfProvider, providerName)) {
		return { info: modelSettingsOfProvider[providerName as ProviderName], source: 'builtin' };
	}
	const ext = _externalProviders.get(providerName);
	return ext ? { info: ext.info, source: ext.source } : undefined;
};

/** All provider ids with their source, for UI iteration/grouping (built-ins first, then externals). */
export const allProviderEntries = (): { id: string; source: ProviderSource }[] => [
	...Object.keys(modelSettingsOfProvider).map(id => ({ id, source: 'builtin' as ProviderSource })),
	...Array.from(_externalProviders.entries(), ([id, v]) => ({ id, source: v.source as ProviderSource })),
];


// ---------------- exports ----------------

// returns the capabilities and the adjusted modelName if it was a fallback
/**
 * Subset of RemoteModelInfo (from IRemoteCatalogService) that getModelCapabilities
 * can actually use to override hardcoded defaults. Kept as a structural type here
 * to avoid pulling the full catalog module into common (no circular dep risk).
 *
 * The catalog is the *authoritative* source for `contextWindow` and `supportsVision`
 * — it's what the provider itself returned via /v1/models. Hardcoded fallbacks
 * are kept ONLY for fields the catalog never exposes (specialToolFormat,
 * supportsSystemMessage, reasoningCapabilities, supportsFIM).
 */
export type CatalogModelHint = {
	contextWindow?: number;
	supportsVision?: boolean;
	modality?: string;
	cost?: { input: number; output: number };
};

/**
 * Capabilities for DYNAMIC providers (`.vibe/providers.json`) keyed `providerId → modelId → caps`.
 * Set by `vibeDynamicProvidersService` (browser) so the pure `getModelCapabilities` below can
 * resolve a provider that isn't in the compile-time `modelSettingsOfProvider`. Module-level, like
 * the settings service's override holder — keeps this function pure of any service dependency.
 */
export const getModelCapabilities = (
	providerName: ProviderName,
	modelName: string,
	overridesOfModel: OverridesOfModel | undefined,
	catalogInfo?: CatalogModelHint | undefined,
): VibeideStaticModelInfo & (
	| { modelName: string; recognizedModelName: string; isUnrecognizedModel: false }
	| { modelName: string; recognizedModelName?: undefined; isUnrecognizedModel: true }
) => {
	// Resolve through the unified registry — built-in OR external (.vibe/providers.json) provider, the
	// SAME path. A dynamic provider is registered as openai-compatible, so its models flow through the
	// same name-recognition (vision/reasoning/tool-format/context) as built-in aggregators. Unknown id
	// ("auto", or a provider removed from the file) → generic default caps, still let catalog fill in.
	const resolved = resolveProvider(providerName);
	if (!resolved) {
		return { modelName, ...defaultModelOptions, ...catalogFields(catalogInfo), isUnrecognizedModel: true };
	}

	const lowercaseModelName = modelName.toLowerCase();

	const { modelOptions, modelOptionsFallback } = resolved.info;

	// Get any override settings for this model. Auto-detected overrides expire
	// after AUTO_DOWNGRADE_TTL_MS — past that point the model gets a fresh
	// chance on whatever default specialToolFormat was, in case the upstream
	// quirk got fixed. Manual user overrides (no `_autoDetected` flag) never
	// expire. See roadmap O.4 (reset mechanism).
	const rawOverrides = overridesOfModel?.[providerName]?.[modelName];
	const overrides = (rawOverrides?._autoDetected && typeof rawOverrides._detectedAt === 'number')
		? (Date.now() - rawOverrides._detectedAt < AUTO_DOWNGRADE_TTL_MS ? rawOverrides : undefined)
		: rawOverrides;

	// Source priority (later wins via spread):
	//   1) hardcoded modelOptions / fallback (baseline + provider-specific fields
	//      that catalogs don't carry: specialToolFormat, supportsSystemMessage,
	//      reasoningCapabilities, supportsFIM)
	//   2) catalog hint (authoritative for contextWindow / supportsVision —
	//      these come straight from the provider's /v1/models response)
	//   3) user / auto-detected overrides (manual user adjustments and TTL'd
	//      auto-downgrade overrides win over everything else)

	// `null` is the persistable "forced off" sentinel in overrides (survives JSON/IPC,
	// unlike undefined) — normalize it back to undefined BEFORE the spread so downstream
	// consumers keep their simple `'openai-style' | … | undefined` view. The key itself
	// stays present so the spread still shadows the baseline value.
	const overridesNorm = (overrides === undefined ? undefined
		: overrides.specialToolFormat === null ? { ...overrides, specialToolFormat: undefined }
			: overrides
	) as (Partial<Omit<ModelOverrides, 'specialToolFormat'>> & { specialToolFormat?: 'openai-style' | 'anthropic-style' | 'gemini-style' }) | undefined;

	// search model options object directly first
	for (const modelName_ in modelOptions) {
		const lowercaseModelName_ = modelName_.toLowerCase();
		if (lowercaseModelName === lowercaseModelName_) {
			return { ...modelOptions[modelName], ...catalogFields(catalogInfo), ...overridesNorm, modelName, recognizedModelName: modelName, isUnrecognizedModel: false };
		}
	}

	const result = modelOptionsFallback(modelName);
	if (result) {
		return { ...result, ...catalogFields(catalogInfo), ...overridesNorm, modelName: result.modelName, isUnrecognizedModel: false };
	}

	return { modelName, ...defaultModelOptions, ...catalogFields(catalogInfo), ...overridesNorm, isUnrecognizedModel: true };
};

/**
 * Extracts ONLY the catalog-authoritative fields (contextWindow, supportsVision,
 * modality, cost). We don't take everything from the catalog — provider-specific
 * routing fields (specialToolFormat etc.) stay in the hardcoded fallback because
 * /v1/models doesn't expose them reliably. Undefined catalog → empty object.
 */
const catalogFields = (info: CatalogModelHint | undefined): Partial<VibeideStaticModelInfo> => {
	if (!info) { return {}; }
	const out: Partial<VibeideStaticModelInfo> = {};
	if (typeof info.contextWindow === 'number' && info.contextWindow > 0) { out.contextWindow = info.contextWindow; }
	if (typeof info.supportsVision === 'boolean') { out.supportsVision = info.supportsVision; }
	if (typeof info.modality === 'string' && info.modality.length > 0) { out.modality = info.modality; }
	if (info.cost && typeof info.cost.input === 'number' && typeof info.cost.output === 'number') {
		out.cost = { input: info.cost.input, output: info.cost.output };
	}
	return out;
};

// non-model settings
export const getProviderCapabilities = (providerName: ProviderName) => {
	// Unified path: built-in OR external (.vibe/providers.json) provider. An external provider is
	// registered as openai-compatible, so it carries the same reasoning IO settings; an unknown id
	// still falls back to openAICompatible rather than destructuring undefined.
	const info = resolveProvider(providerName)?.info ?? modelSettingsOfProvider['openAICompatible'];
	const { providerReasoningIOSettings } = info;
	return { providerReasoningIOSettings };
};


export type SendableReasoningInfo = {
	type: 'budget_slider_value';
	isReasoningEnabled: true;
	reasoningBudget: number;
} | {
	type: 'effort_slider_value';
	isReasoningEnabled: true;
	reasoningEffort: string;
} | null;



export const getIsReasoningEnabledState = (
	featureName: FeatureName,
	providerName: ProviderName,
	modelName: string,
	modelSelectionOptions: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
) => {
	const { supportsReasoning, canTurnOffReasoning } = getModelCapabilities(providerName, modelName, overridesOfModel).reasoningCapabilities || {};
	if (!supportsReasoning) { return false; }

	// default to enabled if can't turn off, or if the featureName is Chat.
	const defaultEnabledVal = featureName === 'Chat' || !canTurnOffReasoning;

	const isReasoningEnabled = modelSelectionOptions?.reasoningEnabled ?? defaultEnabledVal;
	return isReasoningEnabled;
};


export const getReservedOutputTokenSpace = (providerName: ProviderName, modelName: string, opts: { isReasoningEnabled: boolean; overridesOfModel: OverridesOfModel | undefined }) => {
	const {
		reasoningCapabilities,
		reservedOutputTokenSpace,
	} = getModelCapabilities(providerName, modelName, opts.overridesOfModel);
	return opts.isReasoningEnabled && reasoningCapabilities ? reasoningCapabilities.reasoningReservedOutputTokenSpace : reservedOutputTokenSpace;
};

// used to force reasoning state (complex) into something simple we can just read from when sending a message
export const getSendableReasoningInfo = (
	featureName: FeatureName,
	providerName: ProviderName,
	modelName: string,
	modelSelectionOptions: ModelSelectionOptions | undefined,
	overridesOfModel: OverridesOfModel | undefined,
): SendableReasoningInfo => {

	const { reasoningSlider: reasoningBudgetSlider } = getModelCapabilities(providerName, modelName, overridesOfModel).reasoningCapabilities || {};
	const isReasoningEnabled = getIsReasoningEnabledState(featureName, providerName, modelName, modelSelectionOptions, overridesOfModel);
	if (!isReasoningEnabled) { return null; }

	// check for reasoning budget
	const reasoningBudget = reasoningBudgetSlider?.type === 'budget_slider' ? modelSelectionOptions?.reasoningBudget ?? reasoningBudgetSlider?.default : undefined;
	if (reasoningBudget) {
		return { type: 'budget_slider_value', isReasoningEnabled: isReasoningEnabled, reasoningBudget: reasoningBudget };
	}

	// check for reasoning effort
	const reasoningEffort = reasoningBudgetSlider?.type === 'effort_slider' ? modelSelectionOptions?.reasoningEffort ?? reasoningBudgetSlider?.default : undefined;
	if (reasoningEffort) {
		return { type: 'effort_slider_value', isReasoningEnabled: isReasoningEnabled, reasoningEffort: reasoningEffort };
	}

	return null;
};
