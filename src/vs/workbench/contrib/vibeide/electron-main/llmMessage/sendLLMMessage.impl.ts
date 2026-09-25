/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import { vibeLog } from '../../common/vibeLog.js';
import { traceSendEvent } from '../../common/llmSendTrace.js';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions } from 'openai';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
/* eslint-enable */

import { LLMRuntimeOptions, OllamaModelResponse } from '../../common/sendLLMMessageTypes.js';
import { displayInfoOfProviderName, FeatureName, ProviderId, ProviderName, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { getModelCapabilities, defaultProviderSettings } from '../../common/modelCapabilities.js';
import { isLocalAddress, isLocalProvider as isLocalProviderOf } from '../../common/isLocalProvider.js';
import { hash } from '../../../../../base/common/hash.js';
import { ensureSystemCADispatcher, resetSystemCADispatcher } from './systemCAFetch.js';
import { sendViaAISdk } from './aiSdkAdapter.js';
import { assertHttpHeaderSafe, withProcessEnvApiKey } from './llmHelpers.js';
import type { SendChatParams_Internal, SendFIMParams_Internal, ListParams_Internal } from './sendLLMMessage.internalTypes.js';





const invalidApiKeyMessage = (providerName: ProviderId) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`;

// ------------ SDK POOLING FOR LOCAL PROVIDERS ------------

/**
 * In-memory cache for OpenAI-compatible SDK clients (for local providers only).
 * Keyed by: `${providerName}:${endpoint}:${apiKeyHash}`
 * This avoids recreating clients on every request, improving connection reuse.
 */
const openAIClientCache = new Map<string, OpenAI>();

/**
 * In-memory cache for Ollama SDK clients.
 * Keyed by: `${endpoint}`
 */
const ollamaClientCache = new Map<string, Ollama>();

/**
 * Build cache key for OpenAI-compatible client.
 * Format: `${providerName}:${hash(providerSettings)}` — hashing the WHOLE provider settings
 * object (endpoint, apiKey, custom headers, everything the client constructor consumes) so
 * ANY config change produces a new key. The previous endpoint+key-prefix key went stale on
 * header edits in `.vibe/providers.json` ("no tokens until restart", providerDiagnostics.md).
 * Stale entries are left behind until the next reset/restart — a handful of idle SDK objects,
 * not a leak worth an eviction scheme.
 */
const buildOpenAICacheKey = (providerName: ProviderId, settingsOfProvider: SettingsOfProvider): string => {
	return `${providerName}:${hash(JSON.stringify(settingsOfProvider[providerName] ?? null))}`;
};

/**
 * Get or create OpenAI-compatible client with caching for local providers.
 * For local providers (ollama, vLLM, lmStudio, localhost openAICompatible/liteLLM),
 * we cache clients to reuse connections. Cloud providers always get new instances.
 */
const getOpenAICompatibleClient = async ({ settingsOfProvider, providerName, includeInPayload, runtimeOptions }: { settingsOfProvider: SettingsOfProvider; providerName: ProviderId; includeInPayload?: Record<string, unknown>; runtimeOptions?: LLMRuntimeOptions }): Promise<OpenAI> => {
	const isLocalProvider = isLocalProviderOf(providerName, settingsOfProvider);

	// Only cache for local providers
	if (isLocalProvider) {
		const cacheKey = buildOpenAICacheKey(providerName, settingsOfProvider);
		const cached = openAIClientCache.get(cacheKey);
		if (cached) {
			traceSendEvent({ kind: 'client-cache-hit', providerName, detail: 'openai-compatible (local)' });
			return cached;
		}
	}

	// Create new client (will cache if local). runtimeOptions only affects timeout — local
	// clients are cached, so cache hits use the timeout from the FIRST call's runtimeOptions.
	// Acceptable: tunable timeouts mostly matter for cloud/aggregator (we don't cache those).
	traceSendEvent({ kind: 'client-cache-miss', providerName, detail: isLocalProvider ? 'local: создан и закэширован' : 'cloud: клиент на запрос (не кэшируется)' });
	const client = await newOpenAICompatibleSDK({ settingsOfProvider, providerName, includeInPayload, runtimeOptions });

	// Cache if local provider
	if (isLocalProvider) {
		const cacheKey = buildOpenAICacheKey(providerName, settingsOfProvider);
		openAIClientCache.set(cacheKey, client);
	}

	return client;
};

/**
 * Get or create Ollama client with caching.
 */
const getOllamaClient = ({ endpoint }: { endpoint: string }): Ollama => {
	if (!endpoint) { throw new Error(`Ollama Endpoint was empty (please enter ${defaultProviderSettings.ollama.endpoint} in VibeIDE Settings if you want the default url).`); }

	const cached = ollamaClientCache.get(endpoint);
	if (cached) {
		traceSendEvent({ kind: 'client-cache-hit', providerName: 'ollama' });
		return cached;
	}

	traceSendEvent({ kind: 'client-cache-miss', providerName: 'ollama', detail: 'local: создан и закэширован' });
	const ollama = new Ollama({ host: endpoint });
	ollamaClientCache.set(endpoint, ollama);
	return ollama;
};

/**
 * Reset all process-wide LLM transport state without restarting the IDE.
 * Two failure modes share the "no tokens until restart" symptom: (1) local SDK
 * client caches go stale on config change, (2) the shared cloud undici dispatcher
 * can wedge its keep-alive pool. Clears both client caches and recreates the
 * dispatcher. Backs the «reset provider clients» diagnostic action.
 */
export const clearProviderClientCaches = (): void => {
	const openCount = openAIClientCache.size;
	const ollamaCount = ollamaClientCache.size;
	openAIClientCache.clear();
	ollamaClientCache.clear();
	resetSystemCADispatcher();
	traceSendEvent({ kind: 'clients-reset', detail: `очищено ${openCount} OpenAI + ${ollamaCount} Ollama клиентов` });
	vibeLog.warn('sendLLMMessage.impl', `[resetProviderClients] cleared ${openCount} OpenAI + ${ollamaCount} Ollama cached clients; recreated shared dispatcher`);
};

// ------------ OPENAI-COMPATIBLE (HELPERS) ------------

const parseHeadersJSON = (s: string | undefined): Record<string, string | null | undefined> | undefined => {
	if (!s) { return undefined; }
	try {
		return JSON.parse(s);
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`);
	}
};

/**
 * Compute max_tokens/num_predict for local providers based on feature.
 * For local models, we use smaller token limits to reduce latency:
 * - Autocomplete: 64-96 tokens (very small, fast completions)
 * - Ctrl+K / Apply: 150-250 tokens (small edits)
 * - Other/Cloud: 300 tokens (default)
 */
const computeMaxTokensForLocalProvider = (isLocalProvider: boolean, featureName: FeatureName | undefined): number => {
	if (!isLocalProvider) {
		return 300; // Default for cloud providers
	}

	// Infer feature from featureName or default to safe value
	if (featureName === 'Autocomplete') {
		return 96; // Small value for fast autocomplete
	} else if (featureName === 'Ctrl+K' || featureName === 'Apply') {
		return 200; // Medium value for quick edits
	}

	// Default for local providers when featureName is unknown
	return 300;
};

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload, runtimeOptions }: { settingsOfProvider: SettingsOfProvider; providerName: ProviderId; includeInPayload?: Record<string, unknown>; runtimeOptions?: LLMRuntimeOptions }) => {
	// Inherit the provider's OS-env API key when Settings has none. Done once here so every
	// provider branch below reads the resolved key through its usual `settingsOfProvider` lookup.
	settingsOfProvider = withProcessEnvApiKey(settingsOfProvider, providerName);

	// Pre-flight: reject API keys with non-Latin-1 chars before they reach undici as a header.
	const providerCfg: { apiKey?: string } = settingsOfProvider[providerName] ?? {};
	if (typeof providerCfg.apiKey === 'string') {
		assertHttpHeaderSafe(`${displayInfoOfProviderName(providerName).title} API key`, providerCfg.apiKey);
	}

	// Network optimizations: timeouts and connection reuse
	// The OpenAI SDK handles HTTP keep-alive and connection pooling internally

	// Detect local providers: explicit local providers + localhost endpoints
	const isLocalhostEndpoint = isLocalAddress(settingsOfProvider[providerName]?.endpoint);
	const isLocalProvider = isLocalProviderOf(providerName, settingsOfProvider);
	// Aggregator providers: extra hop client→aggregator→upstream adds latency,
	// reasoning models on big context can take 2–3 minutes to first byte.
	const isAggregatorProvider = providerName === 'openRouter'
		|| providerName === 'lmRoute'
		|| providerName === 'liteLLM'
		|| providerName === 'openAICompatible'; // user-configured aggregator endpoint

	// Tunable timeouts (vibeide.llm.timeoutMs.*) with defensive fallbacks.
	const tcfg = runtimeOptions?.timeoutMs;
	const timeoutMs = isLocalProvider
		? (tcfg?.local ?? 30_000)
		: isAggregatorProvider && !isLocalhostEndpoint
			? (tcfg?.aggregator ?? 180_000)
			: (tcfg?.cloud ?? 90_000);
	// Install a system-CA-aware undici dispatcher (idempotent). Required for
	// corporate environments with TLS interception — Node's bundled Mozilla CA
	// list does not include corporate root CAs, so handshake fails with
	// SELF_SIGNED_CERT_IN_CHAIN against opencode.ai/openrouter/etc. Setting the
	// global dispatcher fixes Google SDK too (it uses global fetch).
	const sharedDispatcher = ensureSystemCADispatcher();
	// `dispatcher` is an undici-specific RequestInit extension not declared in the SDK's fetchOptions type.
	const fetchOptions: ClientOptions['fetchOptions'] = { dispatcher: sharedDispatcher };
	const commonPayloadOpts: ClientOptions = {
		dangerouslyAllowBrowser: true,
		timeout: timeoutMs,
		maxRetries: 1, // Reduce retries for local models (they fail fast if not available)
		// Enable HTTP/2 and connection reuse for better performance
		// For localhost, connection reuse is especially important to avoid TCP handshake overhead
		// The OpenAI SDK uses keep-alive by default, which is optimal for localhost
		fetchOptions,
		...includeInPayload,
	};
	// Only FIM (openAICompatible, openRouter, liteLLM, lmRoute) and model listing (vLLM, lmStudio) still
	// talk through the OpenAI client; chat for every provider goes through the AI SDK adapter.
	if (providerName === 'vLLM') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts });
	}
	else if (providerName === 'liteLLM') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts });
	}
	else if (providerName === 'lmRoute') {
		// LM Router (hosted: api.lmrouter.com) uses /openai/v1 path prefix (not /v1), so endpoint is taken as-is.
		// User enters the full baseURL incl. version segment, e.g. https://api.lmrouter.com/openai/v1
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey || 'noop', ...commonPayloadOpts });
	}
	else if (providerName === 'lmStudio') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts });
	}
	else if (providerName === 'openRouter') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({
			baseURL: 'https://openrouter.ai/api/v1',
			apiKey: thisConfig.apiKey,
			defaultHeaders: {
				'HTTP-Referer': 'https://vibeide.com', // Optional, for including your app on openrouter.ai rankings.
				'X-Title': 'VibeIDE', // Optional. Shows in rankings on openrouter.ai.
			},
			...commonPayloadOpts,
		});
	}
	else if (providerName === 'openAICompatible') {
		const thisConfig = settingsOfProvider[providerName];
		const headers = parseHeadersJSON(thisConfig.headersJSON);
		if (headers) {
			for (const [hName, hValue] of Object.entries(headers)) {
				assertHttpHeaderSafe(`OpenAI-Compatible custom header name "${hName}"`, hName);
				if (typeof hValue === 'string') {
					assertHttpHeaderSafe(`OpenAI-Compatible custom header "${hName}" value`, hValue);
				}
			}
		}
		return new OpenAI({ baseURL: thisConfig.endpoint, apiKey: thisConfig.apiKey, defaultHeaders: headers, ...commonPayloadOpts });
	}
	throw new Error(`VibeIDE: no OpenAI-compatible client for provider ${providerName} — its chat goes through the AI SDK adapter.`);
};



const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel, onText, featureName, runtimeOptions }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel);

	// Detect if this is a local provider for streaming optimization
	const isLocalhostEndpoint = isLocalAddress(settingsOfProvider[providerName]?.endpoint);
	const isLocalProvider = isLocalProviderOf(providerName, settingsOfProvider);

	// Check FIM support - only allow if model explicitly supports it OR if it's a provider that supports FIM
	// Providers with FIM support (that use this function):
	// - openRouter: May support FIM depending on backend model
	// - openAICompatible: May support FIM if backend supports it (e.g., local servers)
	// - liteLLM: May support FIM depending on backend
	// Note: mistral and ollama have their own FIM implementations (not this function)
	// Note: OpenAI's official API does NOT support suffix parameter (except gpt-3.5-turbo-instruct)
	// Note: vLLM and lmStudio do NOT support suffix parameter
	const providersWithFIMSupport = ['openRouter', 'openAICompatible', 'liteLLM', 'lmRoute'];
	const hasFIMSupport = providersWithFIMSupport.includes(providerName) || isLocalhostEndpoint;

	if (!supportsFIM && !hasFIMSupport) {
		if (modelName === modelName_) { onError({ message: `Model ${modelName} does not support FIM. OpenAI's official API does not support FIM. Try Mistral (codestral) or local models (Ollama qwen2.5-coder).`, fullError: null }); }
		else { onError({ message: `Model ${modelName_} (${modelName}) does not support FIM. OpenAI's official API does not support FIM. Try Mistral (codestral) or local models (Ollama qwen2.5-coder).`, fullError: null }); }
		return;
	}

	const openai = await getOpenAICompatibleClient({ providerName, settingsOfProvider, includeInPayload: additionalOpenAIPayload, runtimeOptions });

	// Compute max_tokens based on feature and provider type
	const maxTokensForThisCall = computeMaxTokensForLocalProvider(isLocalProvider, featureName);

	// For local models, use streaming FIM for better responsiveness
	// Only stream if onText is provided and not empty (some consumers like autocomplete have empty onText)
	if (isLocalProvider && onText && typeof onText === 'function') {
		let fullText = '';
		let firstTokenReceived = false;
		const firstTokenTimeout = 10_000; // 10 seconds for first token on local models

		const stream = await openai.completions.create({
			model: modelName,
			prompt: prefix,
			suffix: suffix,
			stop: stopTokens,
			max_tokens: maxTokensForThisCall,
			stream: true,
		});

		_setAborter(() => stream.controller?.abort());

		// Set up first token timeout for local models
		const firstTokenTimeoutId = setTimeout(() => {
			if (!firstTokenReceived) {
				stream.controller?.abort();
				onError({
					message: 'Local model took too long to respond for autocomplete. Try a smaller model or a cloud model.',
					fullError: null
				});
			}
		}, firstTokenTimeout);

		try {
			for await (const chunk of stream) {
				// Mark first token received
				if (!firstTokenReceived) {
					firstTokenReceived = true;
					clearTimeout(firstTokenTimeoutId);
				}

				const newText = chunk.choices[0]?.text ?? '';
				fullText += newText;
				onText({
					fullText,
					fullReasoning: '',
					toolCall: undefined,
				});
			}

			// Clear timeout on successful completion
			clearTimeout(firstTokenTimeoutId);
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		} catch (streamError) {
			clearTimeout(firstTokenTimeoutId);
			onError({ message: streamError + '', fullError: streamError instanceof Error ? streamError : new Error(String(streamError)) });
		}
	} else {
		// Non-streaming for remote models (fallback)
		openai.completions
			.create({
				model: modelName,
				prompt: prefix,
				suffix: suffix,
				stop: stopTokens,
				max_tokens: maxTokensForThisCall,
			})
			.then(async response => {
				const fullText = response.choices[0]?.text;
				onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
			})
			.catch(error => {
				if (error instanceof OpenAI.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
				else { onError({ message: error + '', fullError: error }); }
			});
	}
};


type OpenAIModel = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
};
const _openaiCompatibleList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider, providerName }: ListParams_Internal<OpenAIModel>) => {
	const onSuccess = ({ models }: { models: OpenAIModel[] }) => {
		onSuccess_({ models });
	};
	const onError = ({ error }: { error: string }) => {
		onError_({ error });
	};
	try {
		const openai = await getOpenAICompatibleClient({ providerName, settingsOfProvider });
		openai.models.list()
			.then(async (response) => {
				const models: OpenAIModel[] = [];
				models.push(...response.data);
				while (response.hasNextPage()) {
					models.push(...(await response.getNextPage()).data);
				}
				onSuccess({ models });
			})
			.catch((error) => {
				onError({ error: error + '' });
			});
	}
	catch (error) {
		onError({ error: error + '' });
	}
};




// ------------ MISTRAL ------------
// https://docs.mistral.ai/api/#tag/fim
const sendMistralFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, overridesOfModel, modelName: modelName_, _setAborter, providerName }: SendFIMParams_Internal) => {
	const { modelName, supportsFIM } = getModelCapabilities(providerName, modelName_, overridesOfModel);
	if (!supportsFIM) {
		if (modelName === modelName_) { onError({ message: `Model ${modelName} does not support FIM.`, fullError: null }); }
		else { onError({ message: `Model ${modelName_} (${modelName}) does not support FIM.`, fullError: null }); }
		return;
	}

	assertHttpHeaderSafe(`${displayInfoOfProviderName('mistral').title} API key`, settingsOfProvider.mistral.apiKey);
	// Install system-CA-aware global dispatcher (Mistral SDK uses Node global fetch)
	ensureSystemCADispatcher();
	const mistral = new MistralCore({ apiKey: settingsOfProvider.mistral.apiKey });
	fimComplete(mistral,
		{
			model: modelName,
			prompt: messages.prefix,
			suffix: messages.suffix,
			stream: false,
			maxTokens: 300,
			stop: messages.stopTokens,
		})
		.then(async response => {

			// unfortunately, _setAborter() does not exist
			const content = response?.ok ? response.value.choices?.[0]?.message?.content ?? '' : '';
			const fullText = typeof content === 'string' ? content
				: content.map(chunk => (chunk.type === 'text' ? chunk.text : '')).join('');

			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		.catch(error => {
			onError({ message: error + '', fullError: error });
		});
};


// ------------ OLLAMA ------------

const ollamaList = async ({ onSuccess: onSuccess_, onError: onError_, settingsOfProvider }: ListParams_Internal<OllamaModelResponse>) => {
	const onSuccess = ({ models }: { models: OllamaModelResponse[] }) => {
		onSuccess_({ models });
	};
	const onError = ({ error }: { error: string }) => {
		onError_({ error });
	};
	try {
		const thisConfig = settingsOfProvider.ollama;
		const ollama = getOllamaClient({ endpoint: thisConfig.endpoint });
		ollama.list()
			.then((response) => {
				const { models } = response;
				onSuccess({ models });
			})
			.catch((error) => {
				onError({ error: error + '' });
			});
	}
	catch (error) {
		onError({ error: error + '' });
	}
};

const sendOllamaFIM = ({ messages, onFinalMessage, onError, settingsOfProvider, modelName, _setAborter, featureName, onText }: SendFIMParams_Internal) => {
	const thisConfig = settingsOfProvider.ollama;
	const ollama = getOllamaClient({ endpoint: thisConfig.endpoint });

	// Compute num_predict based on feature (Ollama is always local)
	const numPredictForThisCall = computeMaxTokensForLocalProvider(true, featureName);

	let fullText = '';
	ollama.generate({
		model: modelName,
		prompt: messages.prefix,
		suffix: messages.suffix,
		options: {
			stop: messages.stopTokens,
			num_predict: numPredictForThisCall,
			// repeat_penalty: 1,
		},
		raw: true,
		stream: true, // stream is not necessary but lets us expose the
	})
		.then(async stream => {
			_setAborter(() => stream.abort());
			for await (const chunk of stream) {
				const newText = chunk.response;
				fullText += newText;
				// Call onText during streaming for incremental UI updates (like OpenAI-compatible FIM)
				// This enables true streaming UX for Ollama autocomplete
				if (onText && typeof onText === 'function') {
					onText({
						fullText,
						fullReasoning: '',
						toolCall: undefined,
					});
				}
			}
			onFinalMessage({ fullText, fullReasoning: '', anthropicReasoning: null });
		})
		// when error/fail
		.catch((error) => {
			onError({ message: error + '', fullError: error });
		});
};

/**
 * Response-erased list params. The provider map and the channel dispatch each pin a different
 * concrete `ModelResponse` (Ollama vs OpenAI-compatible), so the shared slot uses method-style
 * callbacks (intentionally bivariant) over `unknown[]` to stay assignable in both directions.
 */
type AnyListParams_Internal = Omit<ListParams_Internal<unknown>, 'onSuccess' | 'onError'> & {
	onSuccess(param: { models: unknown[] }): void;
	onError(param: { error: string }): void;
};

type CallFnOfProvider = {
	[providerName in ProviderName]: {
		sendChat: (params: SendChatParams_Internal) => Promise<void>;
		sendFIM: ((params: SendFIMParams_Internal) => void) | null;
		list: ((params: AnyListParams_Internal) => void) | null;
	}
};

/**
 * Routing for DYNAMIC providers (`.vibe/providers.json`) — their id isn't a key in the built-in
 * map below. They go through the SAME AI-SDK path as aggregators (`sendViaAISdk`), inheriting its
 * repair-hook / alias / models.dev-routing / XML-fallback resilience. Transport (baseURL / apiKey /
 * headers) is resolved inside `aiSdkAdapter.resolveEndpoint` from the transient `settingsOfProvider`
 * overlay. Used by the dispatch fallback in `sendLLMMessage.ts`. FIM for dynamics is a follow-up.
 */
export const dynamicProviderImplementation: {
	sendChat: (params: SendChatParams_Internal) => Promise<void>;
	sendFIM: ((params: SendFIMParams_Internal) => void) | null;
	list: ((params: AnyListParams_Internal) => void) | null;
} = {
	sendChat: (params) => sendViaAISdk(params),
	sendFIM: null,
	list: null,
};

export const sendLLMMessageToProviderImplementation = {
	anthropic: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null, // OpenAI's official API doesn't support suffix parameter for FIM
		list: null,
	},
	xAI: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null, // xAI uses OpenAI-compatible API which doesn't support suffix parameter
		list: null,
	},
	gemini: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: sendOllamaFIM,
		list: ollamaList,
	},
	openAICompatible: {
		// Stage 1 migration: aggregator providers go through Vercel AI SDK's
		// @ai-sdk/openai-compatible adapter (normalizes provider-specific quirks
		// in tool_call/reasoning streaming that our manual parser missed). FIM
		// path is untouched.
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	openRouter: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	vLLM: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null, // vLLM's OpenAI-compatible server does not support suffix parameter according to docs
		list: (params) => _openaiCompatibleList(params),
	},
	deepseek: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null, // DeepSeek uses OpenAI-compatible API which doesn't support suffix parameter
		list: null,
	},
	groq: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},

	lmStudio: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null, // lmStudio has no suffix parameter in /completions endpoint, so FIM does not work
		list: (params) => _openaiCompatibleList(params),
	},
	liteLLM: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	lmRoute: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: (params) => _sendOpenAICompatibleFIM(params),
		list: null,
	},
	googleVertex: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	microsoftAzure: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	awsBedrock: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	pollinations: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	openCodeZen: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	openCodeGo: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},
	minimax: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null,
		list: null,
	},

} satisfies CallFnOfProvider;




/*
FIM info (this may be useful in the future with vLLM, but in most cases the only way to use FIM is if the provider explicitly supports it):

qwen2.5-coder https://ollama.com/library/qwen2.5-coder/blobs/e94a8ecb9327
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

codestral https://ollama.com/library/codestral/blobs/51707752a87c
[SUFFIX]{{ .Suffix }}[PREFIX] {{ .Prompt }}

deepseek-coder-v2 https://ollama.com/library/deepseek-coder-v2/blobs/22091531faf0
<|fim_begin|>{{ .Prompt }}<|fim_hole|>{{ .Suffix }}<|fim_end|>

starcoder2 https://ollama.com/library/starcoder2/blobs/3b190e68fefe
<file_sep>
<fim_prefix>
{{ .Prompt }}<fim_suffix>{{ .Suffix }}<fim_middle>
<|end_of_text|>

codegemma https://ollama.com/library/codegemma:2b/blobs/48d9a8140749
<|fim_prefix|>{{ .Prompt }}<|fim_suffix|>{{ .Suffix }}<|fim_middle|>

*/
