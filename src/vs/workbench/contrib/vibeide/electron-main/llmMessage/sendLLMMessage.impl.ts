/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import { vibeLog } from '../../common/vibeLog.js';
import { lenientJsonParseObject } from '../../common/lenientJson.js';
import Anthropic, { ClientOptions as AnthropicClientOptions } from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import OpenAI, { ClientOptions, AzureOpenAI } from 'openai';
import { Stream as OpenAIStream } from 'openai/streaming';
import { MistralCore } from '@mistralai/mistralai/core.js';
import { fimComplete } from '@mistralai/mistralai/funcs/fimComplete.js';
import { Tool as GeminiTool, FunctionDeclaration, GoogleGenAI, ThinkingConfig, Schema, Type } from '@google/genai';
/* eslint-enable */

import { buildContextOverflowError, buildEmptyResponseError, GeminiLLMChatMessage, isContextOverflow, LLMChatMessage, LLMRuntimeOptions, OllamaModelResponse, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { ChatMode, displayInfoOfProviderName, FeatureName, ProviderName, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { getSendableReasoningInfo, getModelCapabilities, getProviderCapabilities, defaultProviderSettings, getReservedOutputTokenSpace } from '../../common/modelCapabilities.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ensureSystemCADispatcher, resetSystemCADispatcher } from './systemCAFetch.js';
import { sendViaAISdk } from './aiSdkAdapter.js';
import { getGoogleApiKey, assertHttpHeaderSafe } from './llmHelpers.js';
import type { SendChatParams_Internal, SendFIMParams_Internal, ListParams_Internal } from './sendLLMMessage.internalTypes.js';





const invalidApiKeyMessage = (providerName: ProviderName) => `Invalid ${displayInfoOfProviderName(providerName).title} API key.`;

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
 * Simple hash function for API keys (for cache key generation).
 * Only used for local providers where security is less critical.
 */
const hashApiKey = (apiKey: string | undefined): string => {
	if (!apiKey) { return 'noop'; }
	// Simple hash - just use first 8 chars for cache key (not for security)
	return apiKey.substring(0, 8);
};


/**
 * Build cache key for OpenAI-compatible client.
 * Format: `${providerName}:${endpoint}:${apiKeyHash}`
 */
const buildOpenAICacheKey = (providerName: ProviderName, settingsOfProvider: SettingsOfProvider): string => {
	let endpoint = '';
	let apiKey = 'noop';

	if (providerName === 'openAI') {
		apiKey = settingsOfProvider[providerName]?.apiKey || '';
	} else if (providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio') {
		endpoint = settingsOfProvider[providerName]?.endpoint || '';
	} else if (providerName === 'openAICompatible' || providerName === 'liteLLM' || providerName === 'lmRoute') {
		endpoint = settingsOfProvider[providerName]?.endpoint || '';
		apiKey = settingsOfProvider[providerName]?.apiKey || '';
	}

	return `${providerName}:${endpoint}:${hashApiKey(apiKey)}`;
};

/**
 * Get or create OpenAI-compatible client with caching for local providers.
 * For local providers (ollama, vLLM, lmStudio, localhost openAICompatible/liteLLM),
 * we cache clients to reuse connections. Cloud providers always get new instances.
 */
const getOpenAICompatibleClient = async ({ settingsOfProvider, providerName, includeInPayload, runtimeOptions }: { settingsOfProvider: SettingsOfProvider; providerName: ProviderName; includeInPayload?: Record<string, unknown>; runtimeOptions?: LLMRuntimeOptions }): Promise<OpenAI> => {
	// Detect if this is a local provider
	const isExplicitLocalProvider = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio';
	let isLocalhostEndpoint = false;
	if (providerName === 'openAICompatible' || providerName === 'liteLLM' || providerName === 'lmRoute') {
		const endpoint = settingsOfProvider[providerName]?.endpoint || '';
		if (endpoint) {
			try {
				const url = new URL(endpoint);
				const hostname = url.hostname.toLowerCase();
				isLocalhostEndpoint = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
			} catch (e) {
				isLocalhostEndpoint = false;
			}
		}
	}
	const isLocalProvider = isExplicitLocalProvider || isLocalhostEndpoint;

	// Only cache for local providers
	if (isLocalProvider) {
		const cacheKey = buildOpenAICacheKey(providerName, settingsOfProvider);
		const cached = openAIClientCache.get(cacheKey);
		if (cached) {
			return cached;
		}
	}

	// Create new client (will cache if local). runtimeOptions only affects timeout — local
	// clients are cached, so cache hits use the timeout from the FIRST call's runtimeOptions.
	// Acceptable: tunable timeouts mostly matter for cloud/aggregator (we don't cache those).
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
		return cached;
	}

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

const newOpenAICompatibleSDK = async ({ settingsOfProvider, providerName, includeInPayload, runtimeOptions }: { settingsOfProvider: SettingsOfProvider; providerName: ProviderName; includeInPayload?: Record<string, unknown>; runtimeOptions?: LLMRuntimeOptions }) => {
	// Pre-flight: reject API keys with non-Latin-1 chars before they reach undici as a header.
	const providerCfg: { apiKey?: string } = settingsOfProvider[providerName] ?? {};
	if (typeof providerCfg.apiKey === 'string') {
		assertHttpHeaderSafe(`${displayInfoOfProviderName(providerName).title} API key`, providerCfg.apiKey);
	}

	// Network optimizations: timeouts and connection reuse
	// The OpenAI SDK handles HTTP keep-alive and connection pooling internally

	// Detect local providers: explicit local providers + localhost endpoints
	const isExplicitLocalProvider = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio';
	let isLocalhostEndpoint = false;
	if (providerName === 'openAICompatible' || providerName === 'liteLLM' || providerName === 'lmRoute') {
		const endpoint = settingsOfProvider[providerName]?.endpoint || '';
		if (endpoint) {
			try {
				// Use proper URL parsing to check hostname (not substring matching)
				const url = new URL(endpoint);
				const hostname = url.hostname.toLowerCase();
				isLocalhostEndpoint = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
			} catch (e) {
				// Invalid URL - assume non-local (safe default)
				isLocalhostEndpoint = false;
			}
		}
	}
	const isLocalProvider = isExplicitLocalProvider || isLocalhostEndpoint;
	// Aggregator providers: extra hop client→aggregator→upstream adds latency,
	// reasoning models on big context can take 2–3 minutes to first byte.
	const isAggregatorProvider = providerName === 'openCodeGo'
		|| providerName === 'openCodeZen'
		|| providerName === 'openRouter'
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
	if (providerName === 'openAI') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'ollama') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: `${thisConfig.endpoint}/v1`, apiKey: 'noop', ...commonPayloadOpts });
	}
	else if (providerName === 'vLLM') {
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
	else if (providerName === 'openCodeZen') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://opencode.ai/zen/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'openCodeGo') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://opencode.ai/zen/go/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'googleVertex') {
		// https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library
		const thisConfig = settingsOfProvider[providerName];
		const baseURL = `https://${thisConfig.region}-aiplatform.googleapis.com/v1/projects/${thisConfig.project}/locations/${thisConfig.region}/endpoints/${'openapi'}`;
		const apiKey = await getGoogleApiKey();
		assertHttpHeaderSafe(`${displayInfoOfProviderName(providerName).title} access token`, apiKey);
		return new OpenAI({ baseURL: baseURL, apiKey: apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'microsoftAzure') {
		// https://learn.microsoft.com/en-us/rest/api/aifoundry/model-inference/get-chat-completions/get-chat-completions?view=rest-aifoundry-model-inference-2024-05-01-preview&tabs=HTTP
		//  https://github.com/openai/openai-node?tab=readme-ov-file#microsoft-azure-openai
		const thisConfig = settingsOfProvider[providerName];
		const endpoint = `https://${thisConfig.project}.openai.azure.com/`;
		const apiVersion = thisConfig.azureApiVersion ?? '2024-04-01-preview';
		const apiKeyRaw = thisConfig.apiKey;
		const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw : '';
		return new AzureOpenAI({ ...commonPayloadOpts, endpoint, apiKey, apiVersion });
	}
	else if (providerName === 'awsBedrock') {
		/**
			* We treat Bedrock as *OpenAI-compatible only through a proxy*:
			*   • LiteLLM default → http://localhost:4000/v1
			*   • Bedrock-Access-Gateway → https://<api-id>.execute-api.<region>.amazonaws.com/openai/
			*
			* The native Bedrock runtime endpoint
			*   https://bedrock-runtime.<region>.amazonaws.com
			* is **NOT** OpenAI-compatible, so we do *not* fall back to it here.
			*/
		const { endpoint, apiKey } = settingsOfProvider.awsBedrock;

		// 1) use the user-supplied proxy if present
		// 2) otherwise default to local LiteLLM
		let baseURL = endpoint || 'http://localhost:4000/v1';

		// Normalize: make sure we end with "/v1"
		if (!baseURL.endsWith('/v1')) { baseURL = baseURL.replace(/\/+$/, '') + '/v1'; }

		return new OpenAI({ baseURL, apiKey, ...commonPayloadOpts });
	}


	else if (providerName === 'deepseek') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://api.deepseek.com/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'minimax') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://api.minimax.io/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
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
	else if (providerName === 'groq') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'xAI') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://api.x.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'mistral') {
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://api.mistral.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}
	else if (providerName === 'pollinations') {
		// Inference is at gen.pollinations.ai; API keys are from enter.pollinations.ai
		const thisConfig = settingsOfProvider[providerName];
		return new OpenAI({ baseURL: 'https://gen.pollinations.ai/v1', apiKey: thisConfig.apiKey, ...commonPayloadOpts });
	}

	else {
		// Dynamic provider (.vibe/providers.json): not a compile-time built-in. Its transport config
		// was merged transiently into settingsOfProvider on the send-site. Route as openai-compatible.
		const cfg = settingsOfProvider[providerName] as unknown as { baseURL?: string; headers?: Record<string, string>; apiKey?: string; apiKeyEnv?: string };
		if (cfg && typeof cfg.baseURL === 'string' && cfg.baseURL) {
			// apiKeyEnv resolves HERE (electron-main has reliable process.env); apiKey came from apiKeyRef.
			const apiKey = cfg.apiKey || (cfg.apiKeyEnv ? (process.env[cfg.apiKeyEnv] ?? '') : '') || 'noop';
			const headers = (cfg.headers && typeof cfg.headers === 'object') ? cfg.headers : undefined;
			if (headers) {
				for (const [hName, hValue] of Object.entries(headers)) {
					assertHttpHeaderSafe(`Dynamic provider "${providerName}" header name "${hName}"`, hName);
					if (typeof hValue === 'string') { assertHttpHeaderSafe(`Dynamic provider "${providerName}" header "${hName}" value`, hValue); }
				}
			}
			return new OpenAI({ baseURL: cfg.baseURL, apiKey, defaultHeaders: headers, ...commonPayloadOpts });
		}
		throw new Error(`VibeIDE providerName was invalid: ${providerName}.`);
	}
};


const _sendOpenAICompatibleFIM = async ({ messages: { prefix, suffix, stopTokens }, onFinalMessage, onError, settingsOfProvider, modelName: modelName_, _setAborter, providerName, overridesOfModel, onText, featureName, runtimeOptions }: SendFIMParams_Internal) => {

	const {
		modelName,
		supportsFIM,
		additionalOpenAIPayload,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel);

	// Detect if this is a local provider for streaming optimization
	// Note: vLLM and lmStudio don't support FIM, so we only check for ollama here
	const isExplicitLocalProvider = providerName === 'ollama';
	let isLocalhostEndpoint = false;
	if (providerName === 'openAICompatible' || providerName === 'liteLLM' || providerName === 'lmRoute') {
		const endpoint = settingsOfProvider[providerName]?.endpoint || '';
		if (endpoint) {
			try {
				// Use proper URL parsing to check hostname (not substring matching)
				const url = new URL(endpoint);
				const hostname = url.hostname.toLowerCase();
				isLocalhostEndpoint = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
			} catch (e) {
				// Invalid URL - assume non-local (safe default)
				isLocalhostEndpoint = false;
			}
		}
	}
	const isLocalProvider = isExplicitLocalProvider || isLocalhostEndpoint;

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


const toOpenAICompatibleTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo;

	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {};
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' }; }

	return {
		type: 'function',
		function: {
			name: name,
			// strict: true, // strict mode - https://platform.openai.com/docs/guides/function-calling?api-mode=chat
			description: description,
			parameters: {
				type: 'object',
				properties: params,
				// required: Object.keys(params), // in strict mode, all params are required and additionalProperties is false
				// additionalProperties: false,
			},
		}
	} satisfies OpenAI.Chat.Completions.ChatCompletionTool;
};

const openAITools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools);
	if (!allowedTools || Object.keys(allowedTools).length === 0) { return null; }

	const openAITools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
	for (const t in allowedTools ?? {}) {
		openAITools.push(toOpenAICompatibleTool(allowedTools[t]));
	}
	return openAITools;
};


// convert LLM tool call to our tool format
const rawToolCallObjOfParamsStr = (name: string, toolParamsStr: string, id: string): RawToolCallObj | null => {
	let input: unknown;
	try { input = JSON.parse(toolParamsStr); }
	catch (e) { input = lenientJsonParseObject(toolParamsStr); } // roadmap 1708: recover malformed JSON args instead of dropping the whole call

	if (input === null) { return null; }
	if (typeof input !== 'object') { return null; }

	const rawParams: RawToolParamsObj = input;
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true };
};


const rawToolCallObjOfAnthropicParams = (toolBlock: Anthropic.Messages.ToolUseBlock): RawToolCallObj | null => {
	const { id, name, input } = toolBlock;

	if (input === null) { return null; }
	if (typeof input !== 'object') { return null; }

	const rawParams: RawToolParamsObj = input;
	return { id, name, rawParams, doneParams: Object.keys(rawParams), isDone: true };
};


// ------------ OPENAI-COMPATIBLE ------------


// Placeholder for empty message content; Vertex/Pollinations require "non-whitespace text", not just a space.
const EMPTY_CONTENT_PLACEHOLDER = '(no content)';

/**
 * Sanitize messages for APIs (e.g. Vertex, Pollinations) that require non-empty, non-whitespace content
 * in every message except the optional final assistant message.
 * Only mutates messages that have a 'content' field (OpenAI/Anthropic style); Gemini-style (parts) are passed through.
 */
const sanitizeOpenAIMessagesForEmptyContent = (messages: LLMChatMessage[]): LLMChatMessage[] => {
	if (!messages?.length) { return messages; }
	const lastIdx = messages.length - 1;
	const result = messages.map((msg, i) => {
		if (!Object.hasOwn(msg, 'content')) { return msg; }
		type ContentPart = { type?: string; text?: string; image_url?: { url?: string } };
		const content = (msg as { role: string; content: string | ContentPart[] }).content;
		const isLastAndAssistant = i === lastIdx && msg.role === 'assistant';
		if (typeof content === 'string') {
			if (content.trim().length > 0) { return msg; }
			if (isLastAndAssistant) { return msg; }
			return { ...msg, content: EMPTY_CONTENT_PLACEHOLDER };
		}
		if (Array.isArray(content)) {
			const hasNonEmptyPart = content.some((p: ContentPart) => (p.type === 'text' && p.text?.trim?.()) || (p.type === 'image_url' && p.image_url?.url));
			if (hasNonEmptyPart || isLastAndAssistant) { return msg; }
			return { ...msg, content: [{ type: 'text', text: EMPTY_CONTENT_PLACEHOLDER }] };
		}
		return msg;
	});
	return result as LLMChatMessage[];
};

/**
 * Walk an Error.cause chain and collect Node/undici diagnostic fields
 * (code, errno, syscall, address, port, hostname). Returns a one-line
 * descriptor like "<message> [code=ECONNRESET host=opencode.ai:443]".
 *
 * OpenAI.APIConnectionError wraps the underlying fetch failure in `cause`
 * (often itself a TypeError whose `cause` is the real undici error). The
 * SDK's default message is just "Connection error.", so without unwrapping
 * we lose every actionable bit (DNS vs TLS vs RST vs proxy vs timeout).
 */
/**
 * Shape of a Node/undici error node in an Error.cause chain. All fields optional —
 * only some are present depending on the failure (DNS vs TLS vs RST vs proxy vs timeout).
 */
interface NodeErrorLike {
	name?: string;
	message?: string;
	code?: string;
	errno?: number;
	syscall?: string;
	address?: string;
	port?: number;
	hostname?: string;
	cause?: unknown;
}

/** Narrow an unknown cause-chain node to {@link NodeErrorLike} (any object qualifies; fields are read defensively). */
const asNodeErrorLike = (value: unknown): NodeErrorLike | undefined => (typeof value === 'object' && value !== null ? value as NodeErrorLike : undefined);

/** Mistral streams structured content parts (text / thinking) that the OpenAI SDK type does not model. */
interface MistralContentPart {
	type?: string;
	text?: string;
	thinking?: { type?: string; text?: string }[];
}

const describeConnectionError = (err: Error): string => {
	const parts: string[] = [];
	let host: string | undefined;
	let port: number | undefined;
	let cur: NodeErrorLike | undefined = asNodeErrorLike(err);
	let depth = 0;
	while (cur && depth < 6) {
		if (cur.code && !parts.some(p => p.startsWith('code='))) { parts.push(`code=${cur.code}`); }
		if (cur.errno !== undefined && !parts.some(p => p.startsWith('errno='))) { parts.push(`errno=${cur.errno}`); }
		if (cur.syscall && !parts.some(p => p.startsWith('syscall='))) { parts.push(`syscall=${cur.syscall}`); }
		if (cur.address && !parts.some(p => p.startsWith('address='))) { parts.push(`address=${cur.address}`); }
		if (typeof cur.port === 'number' && port === undefined) { port = cur.port; }
		if (typeof cur.hostname === 'string' && !host) { host = cur.hostname; }
		cur = asNodeErrorLike(cur.cause);
		depth++;
	}
	if (host || port !== undefined) { parts.push(`host=${host ?? '?'}${port !== undefined ? `:${port}` : ''}`); }
	const baseMsg = err.message || String(err);
	return parts.length ? `${baseMsg} [${parts.join(' ')}]` : baseMsg;
};

/**
 * Serialize an APIConnectionError (and its cause chain) into a plain object
 * that survives structured-clone over IPC. Native Error survives only by name;
 * non-enumerable fields like cause.code/errno are exactly what we need on the
 * renderer side to diagnose the failure.
 */
const serializeConnectionError = (err: Error): object => {
	const causeChain: NodeErrorLike[] = [];
	let cur: NodeErrorLike | undefined = asNodeErrorLike(err.cause);
	let depth = 0;
	while (cur && depth < 6) {
		causeChain.push({
			name: cur.name,
			message: cur.message,
			code: cur.code,
			errno: cur.errno,
			syscall: cur.syscall,
			address: cur.address,
			port: cur.port,
			hostname: cur.hostname,
		});
		cur = asNodeErrorLike(cur.cause);
		depth++;
	}
	return { name: err.name, message: err.message, causeChain };
};

const _sendOpenAICompatibleChat = async ({ messages, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, modelName: modelName_, _setAborter, providerName, chatMode, separateSystemMessage, overridesOfModel, mcpTools, runtimeOptions }: SendChatParams_Internal) => {
	const caps = getModelCapabilities(providerName, modelName_, overridesOfModel);
	const {
		modelName,
		reasoningCapabilities,
		additionalOpenAIPayload,
	} = caps;
	// Honor `vibeide.llm.toolFallbackMode` (with backward-compat from legacy
	// `vibeide.llm.assumeNativeTools`) for aggregator-synthesized fallbacks.
	// Same semantics as in aiSdkAdapter; see roadmap O.8.
	const isAggregatorSynthesized = caps.recognizedModelName === '__aggregator_unknown__';
	const toolFallbackMode = runtimeOptions?.toolFallbackMode ?? 'auto';
	const specialToolFormat = (() => {
		if (!isAggregatorSynthesized) { return caps.specialToolFormat; }
		if (toolFallbackMode === 'native') { return 'openai-style' as const; }
		if (toolFallbackMode === 'xml') { return undefined; }
		if (runtimeOptions?.assumeNativeTools === false) { return undefined; }
		return caps.specialToolFormat;
	})();

	// APIs like Vertex/Pollinations require non-empty content except for the optional final assistant message
	const messagesToSend = sanitizeOpenAIMessagesForEmptyContent(messages);

	const { providerReasoningIOSettings } = getProviderCapabilities(providerName);

	// reasoning
	const { canIOReasoning, openSourceThinkTags } = reasoningCapabilities || {};
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel); // user's modelName_ here

	const includeInPayload = {
		...providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo),
		...additionalOpenAIPayload
	};

	// tools
	const potentialTools = openAITools(chatMode, mcpTools);
	const nativeToolsObj = potentialTools && specialToolFormat === 'openai-style' ?
		{ tools: potentialTools } as const
		: {};

	// instance
	const openai: OpenAI = await getOpenAICompatibleClient({ providerName, settingsOfProvider, includeInPayload, runtimeOptions });
	if (providerName === 'microsoftAzure') {
		// Required to select the model
		(openai as AzureOpenAI).deploymentName = modelName;
	}

	// open source models - manually parse think tokens
	const { needsManualParse: needsManualReasoningParse, nameOfFieldInDelta: nameOfReasoningFieldInDelta } = providerReasoningIOSettings?.output ?? {};
	const manuallyParseReasoning = needsManualReasoningParse && canIOReasoning && openSourceThinkTags;
	if (manuallyParseReasoning) {
		const { newOnText, newOnFinalMessage } = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags);
		onText = newOnText;
		onFinalMessage = newOnFinalMessage;
	}

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools);
		onText = newOnText;
		onFinalMessage = newOnFinalMessage;
	}

	// Variables for tracking response state
	let fullReasoningSoFar = '';
	let fullTextSoFar = '';
	let toolName = '';
	let toolId = '';
	let toolParamsStr = '';
	let isRetrying = false; // Flag to prevent processing streaming chunks during retry
	let timeoutDeliveredPartial = false; // Set when stall timeout fires with partial; outer catch skips onError

	// Detect if this is a local provider for timeout optimization
	const isExplicitLocalProviderChat = providerName === 'ollama' || providerName === 'vLLM' || providerName === 'lmStudio';
	let isLocalhostEndpointChat = false;
	if (providerName === 'openAICompatible' || providerName === 'liteLLM' || providerName === 'lmRoute') {
		const endpoint = settingsOfProvider[providerName]?.endpoint || '';
		if (endpoint) {
			try {
				const url = new URL(endpoint);
				const hostname = url.hostname.toLowerCase();
				isLocalhostEndpointChat = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1';
			} catch (e) {
				isLocalhostEndpointChat = false;
			}
		}
	}
	const isLocalChat = isExplicitLocalProviderChat || isLocalhostEndpointChat;

	// Helper function to process streaming response
	const processStreamingResponse = async (response: OpenAIStream<OpenAI.Chat.Completions.ChatCompletionChunk>) => {
		_setAborter(() => response.controller.abort());

		// For local models: rolling stall timeout (reset on each chunk) so we only fire after no chunk for stallWindow.
		// This prevents premature onFinalMessage(partial) which would freeze the UI while the model keeps streaming.
		const stallWindowMs = isLocalChat ? 60_000 : 0; // 60s of no chunks = stall for local; remote uses one-shot below
		const oneShotTimeoutMs = isLocalChat ? 0 : 120_000; // remote: 120s from start
		const firstTokenTimeout = isLocalChat ? 10_000 : 30_000; // 10s for first token on local

		let firstTokenReceived = false;
		let overallTimeoutId: ReturnType<typeof setTimeout> | null = null;
		let timeoutFired = false;

		const scheduleOverallTimeout = () => {
			if (overallTimeoutId) { clearTimeout(overallTimeoutId); }
			const delay = isLocalChat ? stallWindowMs : oneShotTimeoutMs;
			if (delay <= 0) { return; }
			overallTimeoutId = setTimeout(() => {
				timeoutFired = true;
				if (fullTextSoFar || fullReasoningSoFar || toolName) {
					timeoutDeliveredPartial = true;
					const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId);
					const toolCallObj = toolCall ? { toolCall } : {};
					onFinalMessage({
						fullText: fullTextSoFar,
						fullReasoning: fullReasoningSoFar,
						anthropicReasoning: null,
						...toolCallObj
					});
					response.controller?.abort();
				} else {
					response.controller?.abort();
					onError({
						message: isLocalChat
							? 'Local model timed out (no response for 60s). Try a smaller model or use a cloud model.'
							: 'Request timed out.',
						fullError: null
					});
				}
			}, delay);
		};

		// Start overall timeout: rolling for local (reset on each chunk), one-shot for remote
		scheduleOverallTimeout();

		// Set up first token timeout (only for local models)
		let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null;
		if (isLocalChat) {
			firstTokenTimeoutId = setTimeout(() => {
				if (!firstTokenReceived) {
					response.controller?.abort();
					onError({
						message: 'Local model is too slow (no response after 10s). Try a smaller/faster model or use a cloud model.',
						fullError: null
					});
				}
			}, firstTokenTimeout);
		}

		let lastFinishReason: string | null = null;
		try {
			// when receive text
			for await (const chunk of response) {
				// Check if we're retrying (another response is being processed)
				if (isRetrying) {
					if (overallTimeoutId) { clearTimeout(overallTimeoutId); }
					if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); }
					return; // Stop processing this streaming response, retry is in progress
				}

				// If timeout already fired with partial, stop processing (avoid double onFinalMessage)
				if (timeoutFired) { break; }

				// Mark first token received
				if (!firstTokenReceived) {
					firstTokenReceived = true;
					if (firstTokenTimeoutId) {
						clearTimeout(firstTokenTimeoutId);
						firstTokenTimeoutId = null;
					}
				}

				// Rolling timeout: reset on each chunk for local so we only fire on real stall
				if (isLocalChat) { scheduleOverallTimeout(); }

				// finish_reason is usually only present on the terminal chunk; remember the last non-null value
				lastFinishReason = chunk.choices?.[0]?.finish_reason ?? lastFinishReason;

				// message
				// SDK types `content` as `string | null`, but Mistral can stream a structured content object —
				// widen to `unknown` so the Mistral branch below can narrow it at runtime.
				const newText: unknown = chunk.choices[0]?.delta?.content ?? '';

				// Handle Mistral's object content
				if (providerName === 'mistral' && typeof newText === 'object' && newText !== null) {
					// Parse Mistral's content object
					if (Array.isArray(newText)) {
						for (const item of newText as MistralContentPart[]) {
							if (item.type === 'text' && item.text) {
								fullTextSoFar += item.text;
							} else if (item.type === 'thinking' && Array.isArray(item.thinking)) {
								for (const thinkingItem of item.thinking) {
									if (thinkingItem.type === 'text' && thinkingItem.text) {
										fullReasoningSoFar += thinkingItem.text;
									}
								}
							}
						}
					}
				} else if (typeof newText === 'string') {
					fullTextSoFar += newText;
				}

				// tool call
				// Some aggregator upstreams (openCodeGo/zen/go with minimax-m2.7, certain
				// openAICompatible backends) omit `index` when streaming a single tool_call
				// in one chunk. OpenAI spec requires it; we tolerate its absence by
				// defaulting to slot 0. Tools with index > 0 are intentionally dropped —
				// the accumulator is single-slot and multi-tool support is a separate change.
				for (const tool of chunk.choices[0]?.delta?.tool_calls ?? []) {
					const index = tool.index ?? 0;
					if (index !== 0) { continue; }

					toolName += tool.function?.name ?? '';
					toolParamsStr += tool.function?.arguments ?? '';
					toolId += tool.id ?? '';
				}


				// reasoning
				let newReasoning = '';
				if (nameOfReasoningFieldInDelta) {
					// @ts-ignore
					newReasoning = (chunk.choices[0]?.delta?.[nameOfReasoningFieldInDelta] || '') + '';
					fullReasoningSoFar += newReasoning;
				}

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				});

			}

			// Clear timeouts on successful completion
			if (overallTimeoutId) { clearTimeout(overallTimeoutId); }
			if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); }

			// on final (skip if timeout already fired and committed partial)
			if (timeoutFired) { return; }
			if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
				const reason = lastFinishReason ?? 'unknown';
				const errMessage = isContextOverflow(reason)
					? buildContextOverflowError(providerName, modelName, `finishReason: ${reason}`)
					: buildEmptyResponseError(providerName, modelName, reason);
				onError({ message: errMessage, fullError: null });
			}
			else {
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId);
				const toolCallObj = toolCall ? { toolCall } : {};
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		} catch (streamError) {
			if (overallTimeoutId) { clearTimeout(overallTimeoutId); }
			if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); }
			// If error occurs during streaming, re-throw to be caught by outer catch handler
			throw streamError;
		}
	};

	// Helper function to process non-streaming response
	const processNonStreamingResponse = async (response: OpenAI.Chat.Completions.ChatCompletion) => {
		const choice = response.choices?.[0];
		if (!choice) {
			onError({ message: buildEmptyResponseError(providerName, modelName, 'no_choices'), fullError: null });
			return;
		}

		const fullText = choice.message?.content ?? '';
		const toolCalls = choice.message?.tool_calls ?? [];

		if (toolCalls.length > 0) {
			const toolCall = toolCalls[0];
			if (toolCall.type === 'function') {
				toolName = toolCall.function?.name ?? '';
				toolParamsStr = toolCall.function?.arguments ?? '';
			}
			toolId = toolCall.id ?? '';
		}

		// Call onText once with full text
		onText({
			fullText: fullText,
			fullReasoning: '',
			toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
		});

		// Call onFinalMessage
		const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId);
		const toolCallObj = toolCall ? { toolCall } : {};
		onFinalMessage({ fullText: fullText, fullReasoning: '', anthropicReasoning: null, ...toolCallObj });
	};

	// Try streaming first
	const options: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: modelName,
		messages: messagesToSend as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
		stream: true,
		...nativeToolsObj,
		...additionalOpenAIPayload
		// max_completion_tokens: maxTokens,
	};

	// Flag to ensure we only process one response (prevent duplicate processing)
	// Use object reference to ensure atomic updates across async operations
	const processingState = { responseProcessed: false, isProcessing: false };
	let streamingResponse: OpenAIStream<OpenAI.Chat.Completions.ChatCompletionChunk> | null = null;

	openai.chat.completions
		.create(options)
		.then(async response => {
			// Atomic check-and-set to prevent race conditions
			if (processingState.responseProcessed || processingState.isProcessing || isRetrying) {
				return; // Guard against duplicate processing
			}
			processingState.isProcessing = true;
			streamingResponse = response;
			try {
				await processStreamingResponse(response);
				processingState.responseProcessed = true;
			} finally {
				processingState.isProcessing = false;
			}
		})
		// when error/fail - this catches errors of both .create() and .then(for await)
		.catch(async error => {
			// Stall timeout already delivered partial and aborted; don't show error
			if (timeoutDeliveredPartial) { return; }

			// Abort streaming response if it's still running
			if (streamingResponse) {
				try {
					streamingResponse.controller?.abort();
				} catch (e) {
					// Ignore abort errors
				}
			}

			// Check if this is the organization verification error for streaming
			if (error instanceof OpenAI.APIError &&
				error.status === 400 &&
				error.code === 'unsupported_value' &&
				error.param === 'stream' &&
				error.message?.includes('organization must be verified')) {

				// Set retry flag to stop processing any remaining streaming chunks
				isRetrying = true;

				// Reset state variables before retrying to prevent duplicate content
				fullTextSoFar = '';
				fullReasoningSoFar = '';
				toolName = '';
				toolId = '';
				toolParamsStr = '';

				// Retry with streaming disabled (only retry the API call, not the entire message flow)
				// Silently retry - don't show error notification for organization verification issues
				const nonStreamingOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
					model: modelName,
					messages: messagesToSend as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
					stream: false,
					...nativeToolsObj,
					...additionalOpenAIPayload
				};

				try {
					const response = await openai.chat.completions.create(nonStreamingOptions);
					// Atomic check-and-set to prevent race conditions
					if (processingState.responseProcessed || processingState.isProcessing || !isRetrying) {
						return; // Guard against duplicate processing
					}
					processingState.isProcessing = true;
					try {
						await processNonStreamingResponse(response);
						processingState.responseProcessed = true;
					} finally {
						processingState.isProcessing = false;
					}
					isRetrying = false;
					// Successfully retried with non-streaming - silently continue, no error notification
					return; // Exit early to prevent showing any error
				} catch (retryError) {
					// Log the retry failure for debugging (but don't show confusing error to user)
					vibeLog.debug('sendLLMMessage', '[sendLLMMessage] Retry with non-streaming also failed:', retryError instanceof Error ? retryError.message : String(retryError));
					// If retry also fails, show a generic error instead of silently failing
					// This prevents users from wondering why the model isn't responding
					onError({
						message: 'Failed to get response from model. Please check your API key and organization settings.',
						fullError: retryError instanceof Error ? retryError : new Error(String(retryError))
					});
					return;
				}
			}
			// Check if this is a "model does not support tools" error (e.g., from Ollama)
			else if (error instanceof OpenAI.APIError &&
				error.status === 400 &&
				(error.message?.toLowerCase().includes('does not support tools') ||
					error.message?.toLowerCase().includes('tool') && error.message?.toLowerCase().includes('not support'))) {

				// Set retry flag to stop processing any remaining streaming chunks
				isRetrying = true;

				// Reset state variables before retrying to prevent duplicate content
				fullTextSoFar = '';
				fullReasoningSoFar = '';
				toolName = '';
				toolId = '';
				toolParamsStr = '';

				// Retry without tools - this model doesn't support native tool calling
				// Fall back to XML-based tool calling or regular chat
				// CRITICAL: Retry immediately without delay for tool support errors (they're fast to detect)
				const optionsWithoutTools: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
					model: modelName,
					messages: messagesToSend as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
					stream: true,
					// Explicitly omit tools - don't include nativeToolsObj
					...additionalOpenAIPayload
				};

				try {
					// Use same timeout as original request (already optimized for local models)
					const response = await openai.chat.completions.create(optionsWithoutTools);
					// Atomic check-and-set to prevent race conditions
					if (processingState.responseProcessed || processingState.isProcessing || !isRetrying) {
						return; // Guard against duplicate processing
					}
					processingState.isProcessing = true;
					streamingResponse = response;
					try {
						await processStreamingResponse(response);
						processingState.responseProcessed = true;
					} finally {
						processingState.isProcessing = false;
					}
					isRetrying = false;
					// Successfully retried without tools - silently continue
					// Note: XML-based tool calling will still work if the model supports it
					return; // Exit early to prevent showing any error
				} catch (retryError) {
					// Log the retry failure for debugging
					vibeLog.debug('sendLLMMessage', '[sendLLMMessage] Retry without tools also failed:', retryError instanceof Error ? retryError.message : String(retryError));
					// If retry also fails, show the original error
					onError({
						message: `Model does not support tool calling: ${error.message || 'Unknown error'}`,
						fullError: retryError instanceof Error ? retryError : new Error(String(retryError))
					});
					return;
				}
			}
			else if (error instanceof OpenAI.APIError && error.status === 401) {
				onError({ message: invalidApiKeyMessage(providerName), fullError: error });
			}
			else if (error instanceof OpenAI.APIError && error.status === 429) {
				// Rate limit exceeded - don't retry immediately, show clear error
				const rateLimitMessage = error.message || 'Rate limit exceeded. Please wait a moment before trying again.';
				onError({ message: `Rate limit exceeded: ${rateLimitMessage}`, fullError: error });
			}
			else if (error instanceof OpenAI.APIConnectionError) {
				// Connection error — preserve the underlying undici/Node diagnostic
				// (code/errno/host) instead of collapsing every cause to a single label.
				// The upper layer in sendLLMMessage.ts wraps this in a friendly preamble
				// and appends the bracketed details for diagnosis.
				const diag = describeConnectionError(error);
				vibeLog.warn('sendLLMMessage', `APIConnectionError ${providerName}/${modelName}:`, diag, serializeConnectionError(error));
				onError({ message: `APIConnectionError: ${diag}`, fullError: error });
			}
			else {
				onError({ message: error + '', fullError: error });
			}
		});
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




// ------------ ANTHROPIC (HELPERS) ------------
const toAnthropicTool = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo;
	const paramsWithType: { [s: string]: { description: string; type: 'string' } } = {};
	for (const key in params) { paramsWithType[key] = { ...params[key], type: 'string' }; }
	return {
		name: name,
		description: description,
		input_schema: {
			type: 'object',
			properties: paramsWithType,
			// required: Object.keys(params),
		},
	} satisfies Anthropic.Messages.Tool;
};

const anthropicTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined) => {
	const allowedTools = availableTools(chatMode, mcpTools);
	if (!allowedTools || Object.keys(allowedTools).length === 0) { return null; }

	const anthropicTools: Anthropic.Messages.ToolUnion[] = [];
	for (const t in allowedTools ?? {}) {
		anthropicTools.push(toAnthropicTool(allowedTools[t]));
	}
	return anthropicTools;
};



// ------------ ANTHROPIC ------------
const sendAnthropicChat = async ({ messages, providerName, onText, onFinalMessage, onError, settingsOfProvider, modelSelectionOptions, overridesOfModel, modelName: modelName_, _setAborter, separateSystemMessage, chatMode, mcpTools, runtimeOptions }: SendChatParams_Internal) => {
	const {
		modelName,
		specialToolFormat,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel);

	const thisConfig = settingsOfProvider.anthropic;
	const { providerReasoningIOSettings } = getProviderCapabilities(providerName);

	// reasoning
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel); // user's modelName_ here
	const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {};

	// anthropic-specific - max tokens
	const maxTokens = getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel });

	// tools
	const potentialTools = anthropicTools(chatMode, mcpTools);
	const nativeToolsObj = potentialTools && specialToolFormat === 'anthropic-style' ?
		{ tools: potentialTools, tool_choice: { type: 'auto' } } as const
		: {};


	// instance
	assertHttpHeaderSafe(`${displayInfoOfProviderName('anthropic').title} API key`, thisConfig.apiKey);
	// `dispatcher` is an undici-specific RequestInit extension (trust corporate root CAs from OS store; TLS interception fix).
	const anthropicFetchOptions: AnthropicClientOptions['fetchOptions'] = { dispatcher: ensureSystemCADispatcher() };
	const anthropic = new Anthropic({
		apiKey: thisConfig.apiKey,
		dangerouslyAllowBrowser: true,
		timeout: runtimeOptions?.timeoutMs?.cloud ?? 90_000, // tunable via vibeide.llm.timeoutMs.cloud
		maxRetries: 2, // Fast retries for transient errors
		fetchOptions: anthropicFetchOptions,
		// Connection reuse is handled internally by the SDK
	});

	const stream = anthropic.messages.stream({
		system: separateSystemMessage ?? undefined,
		messages: messages as unknown as Anthropic.MessageParam[], // AnthropicLLMChatMessage type may not exactly match SDK's MessageParam, but is compatible at runtime
		model: modelName,
		max_tokens: maxTokens ?? 4_096, // anthropic requires this
		...includeInPayload,
		...nativeToolsObj,

	});

	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools);
		onText = newOnText;
		onFinalMessage = newOnFinalMessage;
	}

	// when receive text
	let fullText = '';
	let fullReasoning = '';

	let fullToolName = '';
	let fullToolParams = '';


	const runOnText = () => {
		onText({
			fullText,
			fullReasoning,
			toolCall: !fullToolName ? undefined : { name: fullToolName, rawParams: {}, isDone: false, doneParams: [], id: 'dummy' },
		});
	};
	// there are no events for tool_use, it comes in at the end
	stream.on('streamEvent', e => {
		// start block
		if (e.type === 'content_block_start') {
			if (e.content_block.type === 'text') {
				if (fullText) { fullText += '\n\n'; } // starting a 2nd text block
				fullText += e.content_block.text;
				runOnText();
			}
			else if (e.content_block.type === 'thinking') {
				if (fullReasoning) { fullReasoning += '\n\n'; } // starting a 2nd reasoning block
				fullReasoning += e.content_block.thinking;
				runOnText();
			}
			else if (e.content_block.type === 'redacted_thinking') {
				vibeLog.info('sendLLMMessage', 'delta', e.content_block.type);
				if (fullReasoning) { fullReasoning += '\n\n'; } // starting a 2nd reasoning block
				fullReasoning += '[redacted_thinking]';
				runOnText();
			}
			else if (e.content_block.type === 'tool_use') {
				fullToolName += e.content_block.name ?? ''; // anthropic gives us the tool name in the start block
				runOnText();
			}
		}

		// delta
		else if (e.type === 'content_block_delta') {
			if (e.delta.type === 'text_delta') {
				fullText += e.delta.text;
				runOnText();
			}
			else if (e.delta.type === 'thinking_delta') {
				fullReasoning += e.delta.thinking;
				runOnText();
			}
			else if (e.delta.type === 'input_json_delta') { // tool use
				fullToolParams += e.delta.partial_json ?? ''; // anthropic gives us the partial delta (string) here - https://docs.anthropic.com/en/api/messages-streaming
				runOnText();
			}
		}
	});

	// on done - (or when error/fail) - this is called AFTER last streamEvent
	stream.on('finalMessage', (response) => {
		const anthropicReasoning = response.content.filter(c => c.type === 'thinking' || c.type === 'redacted_thinking');
		const tools = response.content.filter(c => c.type === 'tool_use');
		// console.log('TOOLS!!!!!!', JSON.stringify(tools, null, 2))
		// console.log('TOOLS!!!!!!', JSON.stringify(response, null, 2))
		const toolCall = tools[0] && rawToolCallObjOfAnthropicParams(tools[0]);
		const toolCallObj = toolCall ? { toolCall } : {};

		onFinalMessage({ fullText, fullReasoning, anthropicReasoning, ...toolCallObj });
	});
	// on error
	stream.on('error', (error) => {
		if (error instanceof Anthropic.APIError && error.status === 401) { onError({ message: invalidApiKeyMessage(providerName), fullError: error }); }
		else { onError({ message: error + '', fullError: error }); }
	});
	_setAborter(() => stream.controller.abort());
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

// ---------------- GEMINI NATIVE IMPLEMENTATION ----------------

/** Loosely-typed shape of the Gemini 429/RESOURCE_EXHAUSTED error JSON we parse out of the error message. */
interface GeminiRateLimitErrorJson {
	error?: {
		message?: string;
		code?: number;
		status?: string;
		details?: { '@type'?: string; retryDelay?: string }[];
	};
}

const toGeminiFunctionDecl = (toolInfo: InternalToolInfo) => {
	const { name, description, params } = toolInfo;
	return {
		name,
		description,
		parameters: {
			type: Type.OBJECT,
			properties: Object.entries(params).reduce<Record<string, Schema>>((acc, [key, value]) => {
				acc[key] = {
					type: Type.STRING,
					description: value.description
				};
				return acc;
			}, {})
		}
	} satisfies FunctionDeclaration;
};

const geminiTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined): GeminiTool[] | null => {
	const allowedTools = availableTools(chatMode, mcpTools);
	if (!allowedTools || Object.keys(allowedTools).length === 0) { return null; }
	const functionDecls: FunctionDeclaration[] = [];
	for (const t in allowedTools ?? {}) {
		functionDecls.push(toGeminiFunctionDecl(allowedTools[t]));
	}
	const tools: GeminiTool = { functionDeclarations: functionDecls, };
	return [tools];
};



// Implementation for Gemini using Google's native API
const sendGeminiChat = async ({
	messages,
	separateSystemMessage,
	onText,
	onFinalMessage,
	onError,
	settingsOfProvider,
	overridesOfModel,
	modelName: modelName_,
	_setAborter,
	providerName,
	modelSelectionOptions,
	chatMode,
	mcpTools,
}: SendChatParams_Internal) => {

	if (providerName !== 'gemini') { throw new Error(`Sending Gemini chat, but provider was ${providerName}`); }

	const thisConfig = settingsOfProvider[providerName];

	const {
		modelName,
		specialToolFormat,
		// reasoningCapabilities,
	} = getModelCapabilities(providerName, modelName_, overridesOfModel);

	// const { providerReasoningIOSettings } = getProviderCapabilities(providerName)

	// reasoning
	// const { canIOReasoning, openSourceThinkTags, } = reasoningCapabilities || {}
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel); // user's modelName_ here
	// const includeInPayload = providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) || {}

	const thinkingConfig: ThinkingConfig | undefined = !reasoningInfo?.isReasoningEnabled ? undefined
		: reasoningInfo.type === 'budget_slider_value' ?
			{ thinkingBudget: reasoningInfo.reasoningBudget }
			: undefined;

	// tools
	const potentialTools = geminiTools(chatMode, mcpTools);
	const toolConfig = potentialTools && specialToolFormat === 'gemini-style' ?
		potentialTools
		: undefined;

	// instance
	assertHttpHeaderSafe(`${displayInfoOfProviderName(providerName).title} API key`, thisConfig.apiKey);
	// Install system-CA-aware global dispatcher (Google SDK uses Node global fetch)
	ensureSystemCADispatcher();
	const genAI = new GoogleGenAI({ apiKey: thisConfig.apiKey });


	// manually parse out tool results if XML
	if (!specialToolFormat) {
		const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools);
		onText = newOnText;
		onFinalMessage = newOnFinalMessage;
	}

	// when receive text
	const fullReasoningSoFar = '';
	let fullTextSoFar = '';

	let toolName = '';
	let toolParamsStr = '';
	let toolId = '';


	genAI.models.generateContentStream({
		model: modelName,
		config: {
			systemInstruction: separateSystemMessage,
			thinkingConfig: thinkingConfig,
			tools: toolConfig,
		},
		contents: messages as GeminiLLMChatMessage[],
	})
		.then(async (stream) => {
			_setAborter(() => { stream.return(fullTextSoFar); });

			let lastFinishReason: string | null = null;
			let promptBlockReason: string | null = null;

			// Process the stream
			for await (const chunk of stream) {
				// message
				const newText = chunk.text ?? '';
				fullTextSoFar += newText;

				// tool call
				const functionCalls = chunk.functionCalls;
				if (functionCalls && functionCalls.length > 0) {
					const functionCall = functionCalls[0]; // Get the first function call
					toolName = functionCall.name ?? '';
					toolParamsStr = JSON.stringify(functionCall.args ?? {});
					toolId = functionCall.id ?? '';
				}

				// (do not handle reasoning yet)

				// Track finish reason from candidates and any prompt-level safety block (Gemini-specific)
				const chunkMeta = chunk as { candidates?: { finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
				const candidateFinish = chunkMeta.candidates?.[0]?.finishReason;
				if (candidateFinish) { lastFinishReason = candidateFinish; }
				const blockReason = chunkMeta.promptFeedback?.blockReason;
				if (blockReason) { promptBlockReason = blockReason; }

				// call onText
				onText({
					fullText: fullTextSoFar,
					fullReasoning: fullReasoningSoFar,
					toolCall: !toolName ? undefined : { name: toolName, rawParams: {}, isDone: false, doneParams: [], id: toolId },
				});
			}

			// on final
			if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
				const reason = promptBlockReason ? `blocked:${promptBlockReason}` : (lastFinishReason ?? 'unknown');
				const errMessage = isContextOverflow(reason)
					? buildContextOverflowError(providerName, modelName, `finishReason: ${reason}`)
					: buildEmptyResponseError(providerName, modelName, reason);
				onError({ message: errMessage, fullError: null });
			} else {
				if (!toolId) { toolId = generateUuid(); } // ids are empty, but other providers might expect an id
				const toolCall = rawToolCallObjOfParamsStr(toolName, toolParamsStr, toolId);
				const toolCallObj = toolCall ? { toolCall } : {};
				onFinalMessage({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, anthropicReasoning: null, ...toolCallObj });
			}
		})
		.catch(error => {
			const message = error?.message;
			if (typeof message === 'string') {

				if (isContextOverflow(message)) {
					// Gemini emits "input token count NNN exceeds the maximum MMM" on
					// over-budget prompts. Classify before the generic 400-handling so
					// the UI surfaces "compact history" instead of a raw API message.
					onError({ message: buildContextOverflowError(providerName, modelName, message.slice(0, 200)), fullError: error });
				}
				else if (error.message?.includes('API key')) {
					onError({ message: invalidApiKeyMessage(providerName), fullError: error });
				}
				else if (error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED') || error?.message?.includes('quota')) {
					// Parse Gemini rate limit error to extract user-friendly message
					let rateLimitMessage = 'Rate limit reached. Please check your plan and billing details.';
					let retryDelay: string | undefined;

					try {
						// Try to parse the error message which may contain JSON
						let errorData: GeminiRateLimitErrorJson | null = null;

						// First, try to parse the error message as JSON (it might be a JSON string)
						try {
							errorData = JSON.parse(error.message);
						} catch {
							// If that fails, check if error.message contains a JSON string
							const jsonMatch = error.message.match(/\{[\s\S]*\}/);
							if (jsonMatch) {
								errorData = JSON.parse(jsonMatch[0]);
							}
						}

						// Extract user-friendly message from nested structure
						if (errorData?.error?.message) {
							// The message might itself be a JSON string
							try {
								const innerError: GeminiRateLimitErrorJson = JSON.parse(errorData.error.message);
								if (innerError?.error?.message) {
									rateLimitMessage = innerError.error.message;
									// Extract retry delay if available
									const retryInfo = innerError.error.details?.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
									if (retryInfo?.retryDelay) {
										retryDelay = retryInfo.retryDelay;
									}
								}
							} catch {
								// If inner parse fails, use the outer message
								rateLimitMessage = errorData.error.message;
							}
						} else if (errorData?.error?.code === 429 || errorData?.error?.status === 'RESOURCE_EXHAUSTED') {
							// Fallback: use a generic rate limit message
							rateLimitMessage = 'You exceeded your current quota. Please check your plan and billing details.';
						}

						// Format the final message
						let finalMessage = rateLimitMessage;
						if (retryDelay) {
							// Parse retry delay (format: "57s" or "57.627694635s")
							const delaySeconds = parseFloat(retryDelay.replace('s', ''));
							const delayMinutes = Math.floor(delaySeconds / 60);
							const remainingSeconds = Math.ceil(delaySeconds % 60);
							if (delayMinutes > 0) {
								finalMessage += ` Please retry in ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''}${remainingSeconds > 0 ? ` and ${remainingSeconds} second${remainingSeconds > 1 ? 's' : ''}` : ''}.`;
							} else {
								finalMessage += ` Please retry in ${Math.ceil(delaySeconds)} second${Math.ceil(delaySeconds) > 1 ? 's' : ''}.`;
							}
						} else {
							finalMessage += ' Please wait a moment before trying again.';
						}

						// Add helpful links
						finalMessage += ' For more information, see https://ai.google.dev/gemini-api/docs/rate-limits';

						onError({ message: finalMessage, fullError: error });
					} catch (parseError) {
						// If parsing fails, use a generic message
						onError({ message: 'Rate limit reached. Please check your Gemini API quota and billing details. See https://ai.google.dev/gemini-api/docs/rate-limits', fullError: error });
					}
				}
				else { onError({ message: error + '', fullError: error }); }
			}
			else {
				onError({ message: error + '', fullError: error });
			}
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
		sendChat: sendAnthropicChat,
		sendFIM: null,
		list: null,
	},
	openAI: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
		sendFIM: null, // OpenAI's official API doesn't support suffix parameter for FIM
		list: null,
	},
	xAI: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: null, // xAI uses OpenAI-compatible API which doesn't support suffix parameter
		list: null,
	},
	gemini: {
		sendChat: (params) => sendGeminiChat(params),
		sendFIM: null,
		list: null,
	},
	mistral: {
		sendChat: (params) => sendViaAISdk(params),
		sendFIM: (params) => sendMistralFIM(params),
		list: null,
	},
	ollama: {
		sendChat: (params) => _sendOpenAICompatibleChat(params),
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
		sendChat: (params) => _sendOpenAICompatibleChat(params),
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
		sendChat: (params) => _sendOpenAICompatibleChat(params),
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
