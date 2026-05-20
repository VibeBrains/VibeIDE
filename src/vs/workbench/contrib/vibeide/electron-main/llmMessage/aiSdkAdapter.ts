/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import { streamText, jsonSchema, tool, type ModelMessage, type ToolSet, type TextStreamPart, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { API_PROTOCOL_TO_SDK_NPM, ApiProtocolOverride } from '../../common/modelCapabilities.js';

// Module-level memo for SDK-selection diagnostic logs. Keys are
// `${providerName}|${modelName}|${sdkNpm}|${source}` — log once per unique
// combo per process. Prevents per-request spam in long sessions while
// preserving the visibility we want on first use / on routing changes.
const _loggedSdkSelections = new Set<string>();
import { fetch as undiciFetch } from 'undici';
import type { JSONSchema7 } from '@ai-sdk/provider';
/* eslint-enable */

import { generateUuid } from '../../../../../base/common/uuid.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { TOOL_NAME_ALIASES } from '../../common/prompt/toolAliases.js';
import { getModelSdkNpm } from './modelsDevCatalog.js';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { buildEmptyResponseError, LLMChatMessage, LLMTokenUsage, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { ensureSystemCADispatcher } from './systemCAFetch.js';
import { extractReasoningWrapper, extractXMLToolsWrapper } from './extractGrammar.js';
import type { SendChatParams_Internal } from './sendLLMMessage.internalTypes.js';
import { assertHttpHeaderSafe, getGoogleApiKey } from './llmHelpers.js';

// Providers handled by this adapter. The remaining providers (openAI native,
// anthropic, gemini, ollama, vLLM, lmStudio) stay on the legacy path until
// later stages.
export type AiSdkProviderName =
	| 'openCode' | 'openCodeZen' | 'openRouter' | 'openAICompatible' | 'liteLLM' | 'lmRoute' | 'pollinations'
	| 'deepseek' | 'mistral' | 'xAI' | 'groq' | 'awsBedrock' | 'googleVertex' | 'microsoftAzure';

const EMPTY_CONTENT_PLACEHOLDER = '(no content)';

// Stable per-process IDs for opencode.ai aggregator headers (x-opencode-project,
// x-opencode-session). The aggregator uses these for routing/grouping requests;
// stability across calls within the same process is what matters, not real
// project/session correlation with the workspace or chat thread.
const OPENCODE_PROCESS_PROJECT_ID = `vibeide-${generateUuid()}`;
const OPENCODE_PROCESS_SESSION_ID = `vibeide-${generateUuid()}`;

// Per-model AI SDK adapter selection is fully data-driven via models.dev:
// see `modelsDevCatalog.ts`. No hardcoded model names / families / regex —
// the catalog returns the correct `@ai-sdk/*` package per (baseURL, modelName).
// New models (e.g. a hypothetical `maximax-m1`) get the right SDK automatically
// once they appear in models.dev; no code change required.

// Module-level singleton: matches the existing impl which also calls
// ensureSystemCADispatcher() lazily once per OpenAI client construction.
const sharedDispatcher = ensureSystemCADispatcher();

// fetch wrapper that pins the corporate-CA-aware undici dispatcher. We cannot
// pass `dispatcher` directly to streamText() — AI SDK only accepts a standard
// fetch — so we wrap undici.fetch and surface it as a global-fetch lookalike.
const customFetch: typeof globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	return undiciFetch(input as any, { ...(init as any), dispatcher: sharedDispatcher }) as unknown as Promise<Response>;
}) as any;

const parseHeadersJSON = (s: string | undefined): Record<string, string> | undefined => {
	if (!s) return undefined;
	try {
		const obj = JSON.parse(s);
		if (obj && typeof obj === 'object') {
			const out: Record<string, string> = {};
			for (const k of Object.keys(obj)) {
				const v = (obj as any)[k];
				if (typeof v === 'string') out[k] = v;
			}
			return out;
		}
		return undefined;
	} catch (e) {
		throw new Error(`Error parsing OpenAI-Compatible headers: ${s} is not a valid JSON.`);
	}
};

type ResolvedEndpoint = {
	baseURL: string;
	apiKey: string;
	headers?: Record<string, string>;
	queryParams?: Record<string, string>;
};

// Resolve baseURL/apiKey/headers/queryParams per provider. Endpoints mirror the
// legacy getOpenAICompatibleClient branches one-for-one — any change here would
// silently re-route requests.
const resolveEndpoint = async (
	providerName: AiSdkProviderName,
	modelName: string,
	settingsOfProvider: SettingsOfProvider,
): Promise<ResolvedEndpoint> => {
	switch (providerName) {
		// ---------- Aggregators ----------
		case 'openCode': {
			const c = settingsOfProvider.openCode;
			// Headers mimic upstream opencode CLI (anomalyco/opencode session/llm.ts).
			// The opencode.ai/zen aggregator routes prompt-injection / model-formatting
			// based on `x-opencode-*` headers + `User-Agent: opencode/<ver>`. Without
			// them, requests fall to a generic path where minimax/qwen variants emit
			// numeric tool names and miss required params. With them, aggregator
			// applies whatever the opencode CLI session-aware path does and minimax
			// works correctly. See anomalyco/opencode src/session/llm.ts:361-374.
			//
			// We use stable per-process values for project/session (good enough for
			// aggregator routing/grouping; not security-sensitive) and a fresh UUID
			// per request. `x-opencode-client: vibeide` is our honest identification.
			return {
				baseURL: 'https://opencode.ai/zen/go/v1',
				apiKey: c?.apiKey ?? '',
				headers: {
					'User-Agent': 'opencode/0.13.0',
					'x-opencode-client': 'vibeide',
					'x-opencode-project': OPENCODE_PROCESS_PROJECT_ID,
					'x-opencode-session': OPENCODE_PROCESS_SESSION_ID,
					'x-opencode-request': generateUuid(),
				},
			};
		}
		case 'openCodeZen': {
			const c = settingsOfProvider.openCodeZen;
			// Same rationale as openCode — see comment above.
			return {
				baseURL: 'https://opencode.ai/zen/v1',
				apiKey: c?.apiKey ?? '',
				headers: {
					'User-Agent': 'opencode/0.13.0',
					'x-opencode-client': 'vibeide',
					'x-opencode-project': OPENCODE_PROCESS_PROJECT_ID,
					'x-opencode-session': OPENCODE_PROCESS_SESSION_ID,
					'x-opencode-request': generateUuid(),
				},
			};
		}
		case 'openRouter': {
			const c = settingsOfProvider.openRouter;
			return {
				baseURL: 'https://openrouter.ai/api/v1',
				apiKey: c?.apiKey ?? '',
				headers: { 'HTTP-Referer': 'https://vibeide.com', 'X-Title': 'VibeIDE' },
			};
		}
		case 'openAICompatible': {
			const c = settingsOfProvider.openAICompatible;
			const headers = parseHeadersJSON(c?.headersJSON);
			if (headers) {
				for (const [hName, hValue] of Object.entries(headers)) {
					assertHttpHeaderSafe(`OpenAI-Compatible custom header name "${hName}"`, hName);
					if (typeof hValue === 'string') {
						assertHttpHeaderSafe(`OpenAI-Compatible custom header "${hName}" value`, hValue);
					}
				}
			}
			return { baseURL: c?.endpoint ?? '', apiKey: c?.apiKey ?? '', headers };
		}
		case 'liteLLM': {
			const c = settingsOfProvider.liteLLM;
			const endpoint = (c?.endpoint ?? '').replace(/\/+$/, '');
			return { baseURL: `${endpoint}/v1`, apiKey: c?.apiKey || 'noop' };
		}
		case 'lmRoute': {
			const c = settingsOfProvider.lmRoute;
			// Endpoint includes the version segment as-is (e.g. .../openai/v1).
			return { baseURL: c?.endpoint ?? '', apiKey: c?.apiKey || 'noop' };
		}
		case 'pollinations': {
			const c = settingsOfProvider.pollinations;
			return { baseURL: 'https://gen.pollinations.ai/v1', apiKey: c?.apiKey ?? '' };
		}
		// ---------- Direct cloud OpenAI-compat ----------
		case 'deepseek': {
			const c = settingsOfProvider.deepseek;
			return { baseURL: 'https://api.deepseek.com/v1', apiKey: c?.apiKey ?? '' };
		}
		case 'mistral': {
			const c = settingsOfProvider.mistral;
			return { baseURL: 'https://api.mistral.ai/v1', apiKey: c?.apiKey ?? '' };
		}
		case 'xAI': {
			const c = settingsOfProvider.xAI;
			return { baseURL: 'https://api.x.ai/v1', apiKey: c?.apiKey ?? '' };
		}
		case 'groq': {
			const c = settingsOfProvider.groq;
			return { baseURL: 'https://api.groq.com/openai/v1', apiKey: c?.apiKey ?? '' };
		}
		case 'awsBedrock': {
			const c = settingsOfProvider.awsBedrock;
			let baseURL = c?.endpoint || 'http://localhost:4000/v1';
			if (!baseURL.endsWith('/v1')) baseURL = baseURL.replace(/\/+$/, '') + '/v1';
			return { baseURL, apiKey: c?.apiKey ?? '' };
		}
		case 'googleVertex': {
			const c = settingsOfProvider.googleVertex;
			const region = c?.region ?? '';
			const project = c?.project ?? '';
			const apiKey = await getGoogleApiKey();
			assertHttpHeaderSafe('Google Vertex access token', apiKey);
			return {
				baseURL: `https://${region}-aiplatform.googleapis.com/v1/projects/${project}/locations/${region}/endpoints/openapi`,
				apiKey,
			};
		}
		case 'microsoftAzure': {
			const c = settingsOfProvider.microsoftAzure;
			const resource = c?.project ?? '';
			const apiVersion = c?.azureApiVersion ?? '2024-04-01-preview';
			const apiKey = typeof c?.apiKey === 'string' ? c.apiKey : '';
			// Azure URL shape: /openai/deployments/<deployment>/chat/completions?api-version=X.
			// AI SDK appends "/chat/completions" itself, so baseURL stops at the deployment.
			return {
				baseURL: `https://${resource}.openai.azure.com/openai/deployments/${modelName}`,
				apiKey,
				queryParams: { 'api-version': apiVersion },
			};
		}
	}
};

// Look up tool name for a tool_call_id by scanning prior assistant tool_calls.
// AI SDK's ToolResultPart requires toolName, which our message format does not carry.
const buildToolNameLookup = (messages: LLMChatMessage[]): Map<string, string> => {
	const map = new Map<string, string>();
	for (const msg of messages as any[]) {
		if (msg?.role === 'assistant' && Array.isArray(msg.tool_calls)) {
			for (const tc of msg.tool_calls) {
				if (tc?.id && tc?.function?.name) map.set(tc.id, tc.function.name);
			}
		}
	}
	return map;
};

const flattenTextContent = (c: any): string => {
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) {
		return c
			.map((p: any) => (p?.type === 'text' && typeof p?.text === 'string') ? p.text : '')
			.join('');
	}
	return '';
};

// LLMChatMessage[] -> AI SDK ModelMessage[]. Reasoning blocks (Anthropic-style)
// are intentionally dropped here: aggregators do not accept them on input.
const convertMessagesToModelMessages = (messages: LLMChatMessage[]): ModelMessage[] => {
	const toolNameLookup = buildToolNameLookup(messages);
	const lastIdx = messages.length - 1;
	const out: ModelMessage[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as any;
		const isLastAndAssistant = i === lastIdx && msg.role === 'assistant';
		const role = msg.role;

		if (role === 'system' || role === 'developer') {
			// System messages are passed as the top-level `system` option of
			// streamText (Anthropic-compatible, recommended by AI SDK to avoid
			// prompt-injection warnings + correct routing on @ai-sdk/anthropic
			// where system goes into the request's top-level `system` field).
			// Drop here; sendViaAISdk extracts separateSystemMessage and passes
			// it to streamText as `system: ...`.
			continue;
		}

		if (role === 'user') {
			const content = msg.content;
			if (typeof content === 'string') {
				out.push({ role: 'user', content: content.trim() ? content : EMPTY_CONTENT_PLACEHOLDER });
			} else if (Array.isArray(content)) {
				const parts: any[] = [];
				for (const p of content) {
					if (p?.type === 'text' && typeof p?.text === 'string') {
						parts.push({ type: 'text', text: p.text });
					} else if (p?.type === 'image_url' && p?.image_url?.url) {
						const url: string = p.image_url.url;
						try { parts.push({ type: 'image', image: new URL(url) }); }
						catch { parts.push({ type: 'image', image: url }); }
					}
				}
				if (parts.length === 0) parts.push({ type: 'text', text: EMPTY_CONTENT_PLACEHOLDER });
				out.push({ role: 'user', content: parts });
			} else {
				out.push({ role: 'user', content: EMPTY_CONTENT_PLACEHOLDER });
			}
			continue;
		}

		if (role === 'assistant') {
			const parts: any[] = [];
			const content = msg.content;
			// AI SDK 4.x supports `{ type: 'reasoning', text }` parts inside assistant
			// messages. Providers that natively understand thinking-mode roundtrip
			// (DeepSeek via openai-compatible, openCode/zen-proxied reasoning models)
			// require the previous assistant's `reasoning_content` to be sent back —
			// without it the provider rejects continuation with HTTP 400 "must be
			// passed back". Surface it FIRST (before text/tool-call parts) so the SDK
			// emits it in the right slot.
			const reasoningPayload: string | undefined = (msg as any).reasoning_content || (msg as any).reasoning;
			if (typeof reasoningPayload === 'string' && reasoningPayload.length > 0) {
				parts.push({ type: 'reasoning', text: reasoningPayload });
			}
			if (typeof content === 'string' && content.length > 0) {
				parts.push({ type: 'text', text: content });
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (p?.type === 'text' && typeof p?.text === 'string') {
						parts.push({ type: 'text', text: p.text });
					}
					// AnthropicReasoning parts intentionally skipped.
				}
			}
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					let input: any = {};
					try { input = JSON.parse(tc?.function?.arguments ?? '{}'); }
					catch { input = {}; }
					parts.push({
						type: 'tool-call',
						toolCallId: tc?.id ?? generateUuid(),
						toolName: tc?.function?.name ?? '',
						input,
					});
				}
			}
			if (parts.length === 0) {
				out.push({ role: 'assistant', content: isLastAndAssistant ? '' : EMPTY_CONTENT_PLACEHOLDER });
			} else {
				out.push({ role: 'assistant', content: parts });
			}
			continue;
		}

		if (role === 'tool') {
			const callId: string = msg.tool_call_id ?? '';
			const toolName: string = toolNameLookup.get(callId) ?? 'unknown_tool';
			const text = typeof msg.content === 'string' ? msg.content : flattenTextContent(msg.content);

			// Two-stage orphan-tool guard.
			//
			// (1) Source-level orphan: if NO assistant message in the original `messages`
			//     array contains a tool_call with this callId, the tool message is a true
			//     orphan — auto-summary dropped its parent assistant turn entirely. We
			//     can't synthesize a faithful replacement: strict providers (DeepSeek
			//     thinking via openCode) require `reasoning_content` on the assistant
			//     turn, and we have no reasoning to attach. A bare tool-call stub passes
			//     the "tool must follow tool_calls" check but fails the
			//     "reasoning_content must be passed back" check. Dropping the orphan tool
			//     is the only safe option — the model will re-call if it needs the result.
			//
			// (2) Out-level orphan: source has the tool_call, but the assistant carrying
			//     it hasn't been pushed to `out` yet (some upstream filter or ordering
			//     quirk). Rare, but still recoverable with a stub because in this branch
			//     we know a corresponding assistant existed — no DeepSeek reasoning
			//     requirement applies because original source-level structure is intact.
			let hasMatchingInSource = false;
			for (const m of messages as any[]) {
				if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
					if (m.tool_calls.some((tc: any) => tc?.id === callId)) {
						hasMatchingInSource = true;
						break;
					}
				}
			}

			let hasMatchingInOut = false;
			for (let j = out.length - 1; j >= 0; j--) {
				const m: any = out[j];
				if (m.role === 'assistant' && Array.isArray(m.content)) {
					if (m.content.some((p: any) => p?.type === 'tool-call' && p?.toolCallId === callId)) {
						hasMatchingInOut = true;
					}
					break;
				}
				if (m.role === 'user') break;
			}

			// True orphan from auto-summary: no matching assistant.tool_call exists in
			// source. Two failure modes to avoid:
			//   - Push tool-result alone → DeepSeek 400 "tool must follow tool_calls".
			//   - Drop the tool message entirely → model loses memory of its own prior
			//     call, decides "tool not executed", re-invokes the same tool → infinite
			//     agent loop (the orphan reappears on every iteration after summary).
			// Fix: synthesize the missing assistant with a reasoning placeholder (DeepSeek
			// thinking accepts any non-empty `reasoning` here — it only rejects when the
			// field is absent entirely), then replace the tool's content with an explicit
			// "result was discarded by summary" message so the model knows not to retry.
			if (!hasMatchingInSource) {
				out.push({
					role: 'assistant',
					content: [
						// Non-empty placeholder satisfies DeepSeek's "reasoning_content must
						// be passed back" check. Content is intentionally short and explicit.
						{ type: 'reasoning', text: '(reasoning omitted during conversation summarization)' },
						{ type: 'tool-call', toolCallId: callId, toolName, input: {} },
					],
				});
				out.push({
					role: 'tool',
					content: [{
						type: 'tool-result',
						toolCallId: callId,
						toolName,
						output: {
							type: 'text',
							value:
								`(Original tool result was discarded by conversation summarization. ` +
								`Do NOT re-invoke this tool with the same arguments — assume the work was done ` +
								`and continue from here. If you genuinely need this data again, call with different args.)`,
						},
					}],
				});
				continue;
			}

			if (!hasMatchingInOut) {
				out.push({
					role: 'assistant',
					content: [{
						type: 'tool-call',
						toolCallId: callId,
						toolName,
						input: {},
					}],
				});
			}

			out.push({
				role: 'tool',
				content: [{
					type: 'tool-result',
					toolCallId: callId,
					toolName,
					output: { type: 'text', value: text || EMPTY_CONTENT_PLACEHOLDER },
				}],
			});
			continue;
		}
	}

	return out;
};

// Reserved tool name for routing repair-misses. Models occasionally emit
// numeric or otherwise-invalid tool names (e.g. "2", "5", "20") that lookalike
// an index into a numbered list rather than an identifier. By adding a real
// `invalid` tool to the AI SDK ToolSet (hidden from the model via `activeTools`)
// we give the SDK a valid target the repair hook can rewrite to, instead of
// throwing NoSuchToolError. The tool's `execute` returns a short error string,
// matching Kilo Code's pattern (packages/opencode/src/tool/invalid.ts), so the
// model reads a normal tool_result on the next turn and re-issues correctly.
// chatThreadService keeps a parallel short-circuit for non-AI-SDK channels.
export const INVALID_TOOL_NAME = 'invalid' as const;

// InternalToolInfo map -> AI SDK ToolSet. Real tools have no `execute`: the
// model's tool_call is surfaced via the stream and dispatched manually by
// chatThreadService. The `invalid` pseudo-tool is the one exception — it
// carries an `execute` so the SDK can finalise the turn cleanly when the
// repair hook reroutes to it.
//
// `required` is derived heuristically: any param whose description does NOT
// start with "Optional." (case-insensitive, leading whitespace ignored) is
// treated as required. This forces OpenAI-compatible models to populate the
// canonical field — without it, models can validly emit a tool_call with
// empty `{}` and only crash at our internal validator with a confusing
// "Provided uri must be a string, but it's a(n) undefined" error.
const convertToolsToAiSdkToolSet = (
	allowed: InternalToolInfo[] | { [k: string]: InternalToolInfo } | null | undefined,
	includeInvalidTool: boolean
): ToolSet | undefined => {
	const out: ToolSet = {};
	if (allowed) {
		// `availableTools()` returns InternalToolInfo[] (an array). Earlier code
		// declared the param type as a record and used `Object.keys(allowed)` to
		// iterate — but for an array that returns the INDEX strings `"0", "1",
		// "2", ...`, which we then used as the tool NAME registered with the
		// SDK. The model received `tools: [{name: "0", description: "..."},
		// {name: "1", ...}, ...]` and emitted tool calls by those numeric names
		// — perfectly reasonable on its part, but completely broken for our
		// dispatcher. This was the root cause of the "minimax numeric tool name"
		// bug we chased through ~10 hours of debugging. Iterate as a real array,
		// take the canonical `t.name` from each entry, and use THAT as the
		// registered key.
		const toolsArray: InternalToolInfo[] = Array.isArray(allowed)
			? allowed
			: Object.values(allowed);
		for (const t of toolsArray) {
			const name = t.name;
			if (!name) continue;
			const properties: Record<string, { description: string; type: 'string' }> = {};
			const required: string[] = [];
			for (const k of Object.keys(t.params)) {
				const desc = t.params[k].description;
				properties[k] = { description: desc, type: 'string' };
				if (!desc.trimStart().toLowerCase().startsWith('optional')) {
					required.push(k);
				}
			}
			out[name] = tool({
				description: t.description,
				inputSchema: jsonSchema({
					type: 'object',
					properties,
					...(required.length > 0 ? { required } : {}),
				} as JSONSchema7),
			});
		}
	}
	if (includeInvalidTool) {
		out[INVALID_TOOL_NAME] = tool({
			description: 'Do not use. Reserved for repair routing.',
			inputSchema: jsonSchema({
				type: 'object',
				properties: {
					tool: { type: 'string', description: 'Original tool name the model attempted.' },
					error: { type: 'string', description: 'Why the call was considered invalid.' },
				},
			} as JSONSchema7),
			execute: async (args: unknown) => {
				const a = (args ?? {}) as { tool?: string; error?: string };
				const reason = (typeof a.error === 'string' && a.error) ? a.error : 'Unknown tool call';
				return `The arguments provided to the tool are invalid: ${reason}`;
			},
		});
	}
	return Object.keys(out).length === 0 ? undefined : out;
};

export const sendViaAISdk = async (params: SendChatParams_Internal): Promise<void> => {
	const {
		messages,
		onText: onText_,
		onFinalMessage: onFinalMessage_,
		onError,
		settingsOfProvider,
		modelName: modelName_,
		_setAborter,
		providerName,
		chatMode,
		overridesOfModel,
		mcpTools,
		runtimeOptions,
		separateSystemMessage,
	} = params;

	const caps = getModelCapabilities(providerName, modelName_, overridesOfModel);
	const { modelName, additionalOpenAIPayload, reasoningCapabilities } = caps;

	// Honor `vibeide.llm.toolFallbackMode` (with backward-compat from legacy
	// `vibeide.llm.assumeNativeTools`) for aggregator-synthesized fallbacks.
	// Scope is intentionally narrow: known models (Claude, GPT, etc.) keep their
	// catalog-defined specialToolFormat regardless. See roadmap O.8.
	const isAggregatorSynthesized = caps.recognizedModelName === '__aggregator_unknown__';
	const toolFallbackMode = runtimeOptions?.toolFallbackMode ?? 'auto';
	const specialToolFormat = (() => {
		if (!isAggregatorSynthesized) return caps.specialToolFormat;
		// `native`: force native FC even over auto-detected overrides (`caps.specialToolFormat`
		// may be `undefined` if an auto-downgrade already fired — user wants to override that).
		if (toolFallbackMode === 'native') return 'openai-style' as const;
		// `xml`: force XML-in-prompt regardless of caps.
		if (toolFallbackMode === 'xml') return undefined;
		// `auto`: respect caps (which respects user/auto-detected overrides).
		// Legacy backward-compat: assumeNativeTools=false still forces xml here.
		if (runtimeOptions?.assumeNativeTools === false) return undefined;
		return caps.specialToolFormat;
	})();

	// Open-source think-tag reasoning: wrap callbacks to extract <think>...</think>.
	const openSourceThinkTags = (reasoningCapabilities && (reasoningCapabilities as any).openSourceThinkTags) as [string, string] | undefined;
	let onText = onText_;
	let onFinalMessage = onFinalMessage_;
	if (openSourceThinkTags) {
		const wrapped = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags);
		onText = wrapped.newOnText;
		onFinalMessage = wrapped.newOnFinalMessage;
	}
	// XML tool fallback when native tools are disabled for this model.
	if (!specialToolFormat) {
		const wrapped = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools);
		onText = wrapped.newOnText;
		onFinalMessage = wrapped.newOnFinalMessage;
	}

	let resolved: ResolvedEndpoint;
	try {
		resolved = await resolveEndpoint(providerName as AiSdkProviderName, modelName, settingsOfProvider);
	} catch (e: any) {
		onError({ message: e?.message ?? String(e), fullError: e instanceof Error ? e : null });
		return;
	}
	const { baseURL, apiKey, headers, queryParams } = resolved;
	if (!baseURL) {
		onError({ message: `${providerName}: missing endpoint configuration.`, fullError: null });
		return;
	}

	// Pick AI SDK adapter per model. Priority order:
	//   1. User-set `apiProtocol` override in ModelOverrides — bypasses
	//      everything below. Required when models.dev mis-classifies a model
	//      or when a model isn't in the catalog at all (e.g. new aggregator
	//      additions, corporate-network blocking models.dev fetch).
	//   2. models.dev catalog (data-driven) — returns the `npm` field
	//      (`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, etc.) for the
	//      (baseURL, modelName) tuple.
	//   3. Fallback: openai-compatible (safe default; even if wrong, the
	//      auto-downgrade pipeline catches resulting tool-call quirks).
	const apiProtocolOverride = (overridesOfModel?.[providerName as Exclude<typeof providerName, 'auto'>]?.[modelName_] as { apiProtocol?: ApiProtocolOverride } | undefined)?.apiProtocol;
	// Map override → SDK npm via the shared const in modelCapabilities (single
	// source of truth — adding a new protocol there propagates here automatically).
	const sdkNpmFromOverride: string | undefined = apiProtocolOverride
		? API_PROTOCOL_TO_SDK_NPM[apiProtocolOverride]
		: undefined;
	const sdkNpm = sdkNpmFromOverride ?? await getModelSdkNpm(baseURL, modelName);
	// Diagnostic: log which SDK path was taken on the FIRST request per
	// (provider × model × source). Cache key prevents per-request spam in
	// long sessions. Downgraded to console.debug (hidden by default in
	// devtools) — the routing decision was once-suspect, now stable.
	// Bypass the dedup if it actually changes for the same combo (rare, but
	// e.g. catalog refresh mid-session could switch sdkNpm).
	const sdkSource = sdkNpmFromOverride ? 'override' : (sdkNpm ? 'models.dev' : 'fallback');
	const sdkLogKey = `${providerName}|${modelName}|${sdkNpm ?? 'fallback'}|${sdkSource}`;
	if (!_loggedSdkSelections.has(sdkLogKey)) {
		_loggedSdkSelections.add(sdkLogKey);
		console.debug(`[aiSdkAdapter] provider=${providerName} model=${modelName} baseURL=${baseURL} sdkNpm=${sdkNpm ?? '(unknown → fallback openai-compatible)'} source=${sdkSource}`);
	}
	const languageModel: LanguageModel = sdkNpm === '@ai-sdk/anthropic'
		? createAnthropic({
			baseURL,
			apiKey,
			headers: {
				...headers,
				// Anthropic-beta flags mirrored from opencode CLI (anomalyco/opencode
				// provider/provider.ts:155-165 "anthropic" custom config). Without
				// `fine-grained-tool-streaming-2025-05-14` the tool_use stream comes
				// through in a coarser format that minimax-style models render as
				// degenerate output (numeric tool names, empty params). The
				// `interleaved-thinking` flag is for reasoning models.
				'anthropic-beta': 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
			},
			fetch: customFetch as any,
		})(modelName)
		: sdkNpm === '@ai-sdk/openai'
			? // Native OpenAI SDK. Default `.chat()` shape — chat-completions endpoint
			// (NOT the new Responses API; that'd be `.responses()` and requires
			// downstream payload changes we haven't done). Functionally equivalent
			// to openai-compatible for our use-case, but uses the native serializer
			// which preserves OpenAI-specific fields (logprobs, parallel_tool_calls,
			// etc.) without the openai-compatible "unknown field" stripping.
			createOpenAI({
				baseURL,
				apiKey,
				headers,
				fetch: customFetch as any,
			}).chat(modelName)
			: sdkNpm === '@ai-sdk/google'
				? // Native Google Generative AI (Gemini). Activated when models.dev
				// catalog returns this SDK for the (baseURL, modelName) pair, or
				// when user sets apiProtocol="google" override. NOTE: the standalone
				// `gemini` VibeIDE provider still uses its own `sendGeminiChat` path
				// — that's a separate codepath and is NOT touched here. This branch
				// only kicks in for Gemini models served via aggregator
				// (openCode/zen with Gemini, openRouter with Gemini, etc.) where
				// the request flows through sendViaAISdk. Tool-call format is
				// functionDeclarations / functionCall — different from OpenAI shape
				// — but @ai-sdk/google handles that conversion internally.
				createGoogleGenerativeAI({
					baseURL,
					apiKey,
					headers,
					fetch: customFetch as any,
				})(modelName)
				: createOpenAICompatible({
					name: providerName,
					baseURL,
					apiKey,
					headers,
					queryParams,
					fetch: customFetch as any,
					includeUsage: true,
					transformRequestBody: additionalOpenAIPayload
						? (body) => ({ ...body, ...(additionalOpenAIPayload as Record<string, unknown>) })
						: undefined,
				}).chatModel(modelName);

	const modelMessages = convertMessagesToModelMessages(messages);
	// Tools-field policy:
	//   - specialToolFormat set (known native-FC-capable model) → pass tools.
	//     Repair hook + `invalid` pseudo-tool catch quirks.
	//   - specialToolFormat undefined → DO NOT pass tools. Model gets tool
	//     definitions via system-prompt XML grammar (includeXMLToolDefinitions),
	//     and emits calls as XML in text which extractXMLToolsWrapper parses.
	//     This is the path for minimax / qwen-via-aggregator and any model
	//     where native FC routinely fails (numeric tool names, missing fields).
	//
	// The previous "always pass tools" decision was reverted because aggregator
	// routes for minimax/qwen forced native FC even though their training
	// quirks make it unusable. Gating restores per-model control: known good
	// models keep native, known broken models get XML-only.
	//
	// `invalid` pseudo-tool only injected when tools are passed; otherwise the
	// repair hook has nothing to repair.
	const tools = specialToolFormat
		? convertToolsToAiSdkToolSet(availableTools(chatMode, mcpTools), true)
		: undefined;
	const activeTools = tools
		? Object.keys(tools).filter(k => k !== INVALID_TOOL_NAME)
		: undefined;

	// Aggregators: extra hop adds latency. Default 180s.
	const timeoutMs = runtimeOptions?.timeoutMs?.aggregator ?? 180_000;

	const abortController = new AbortController();
	let timeoutFired = false;
	let timeoutDeliveredPartial = false;
	_setAborter(() => abortController.abort());

	// Accumulators
	let fullTextSoFar = '';
	let fullReasoningSoFar = '';
	let toolName = '';
	let toolId = '';
	let toolParamsStr = '';
	let firstTokenReceived = false;
	let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let overallTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let lastFinishReason: string | null = null;
	// Last `usage` block emitted by the AI SDK on `finish-step` / `finish` parts.
	// We surface this in onFinalMessage so the UI can display real prompt/completion
	// token counts from the provider instead of relying on length/4 heuristics.
	let lastUsage: LLMTokenUsage | undefined;

	const clearAllTimers = () => {
		if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); firstTokenTimeoutId = null; }
		if (overallTimeoutId) { clearTimeout(overallTimeoutId); overallTimeoutId = null; }
	};

	const markFirstToken = () => {
		if (firstTokenReceived) return;
		firstTokenReceived = true;
		if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); firstTokenTimeoutId = null; }
	};

	const buildPartialToolCallObj = (): RawToolCallObj | undefined => {
		if (!toolName) return undefined;
		return { name: toolName as any, rawParams: {} as RawToolParamsObj, doneParams: [], id: toolId, isDone: false };
	};

	const finalizeToolCall = (): RawToolCallObj | null => {
		if (!toolName) return null;
		let input: unknown;
		try { input = JSON.parse(toolParamsStr || '{}'); }
		catch { return null; }
		if (input === null || typeof input !== 'object') return null;
		const rawParams = input as RawToolParamsObj;
		return {
			id: toolId || generateUuid(),
			name: toolName as any,
			rawParams,
			doneParams: Object.keys(rawParams) as any,
			isDone: true,
		};
	};

	firstTokenTimeoutId = setTimeout(() => {
		if (!firstTokenReceived) abortController.abort(new Error('First-token timeout'));
	}, 30_000);

	overallTimeoutId = setTimeout(() => {
		timeoutFired = true;
		if (fullTextSoFar || fullReasoningSoFar || toolName) {
			timeoutDeliveredPartial = true;
			const tc = finalizeToolCall();
			onFinalMessage({
				fullText: fullTextSoFar,
				fullReasoning: fullReasoningSoFar,
				anthropicReasoning: null,
				...(tc ? { toolCall: tc } : {}),
				...(lastUsage ? { usage: lastUsage } : {}),
			});
		} else {
			onError({ message: 'Request timed out.', fullError: null });
		}
		abortController.abort();
	}, timeoutMs);

	try {
		const result = streamText({
			model: languageModel,
			// Top-level `system` (Anthropic-style). AI SDK routes this to the
			// request's top-level `system` field for @ai-sdk/anthropic and
			// prepends as a system role for openai-compatible. Avoids the
			// "System messages in the prompt or messages fields can be a
			// security risk" warning AND ensures minimax/Anthropic-protocol
			// models actually see the tool instructions (previously dropped
			// when system was inside messages array on the Anthropic path).
			system: separateSystemMessage,
			messages: modelMessages,
			tools,
			activeTools,
			toolChoice: tools ? 'auto' : undefined,
			abortSignal: abortController.signal,
			// AI SDK default maxRetries=2 (3 attempts total) is too aggressive for
			// aggregator-proxied models (openCode/zen → DeepSeek-thinking, BigPickle,
			// minimax-m2.7) — those upstreams throttle on bursts of agentic steps and
			// 3 attempts hit the same rate-limit window. 5 retries = 6 attempts with
			// AI SDK's exp backoff (2^n: 0s / 2s / 4s / 8s / 16s / 32s ≈ ~60s spread),
			// giving the upstream window time to reset. Doesn't affect non-throttled
			// cases — successful first attempt skips backoff entirely.
			maxRetries: 5,
			// Four-stage repair for tool-call name mismatches:
			//   1. Lowercase normalisation (Read_File → read_file, BASH → bash).
			//   2. Cross-ecosystem alias (read → read_file, edit → edit_file,
			//      apply_patch → edit_file, fetch → browse_url) via shared
			//      TOOL_NAME_ALIASES in common/prompt/toolAliases.
			//   3. **Positional fallback for numeric tool names.** Some models
			//      (minimax-m2.x, certain qwen variants) emit tool calls as
			//      `"5"` meaning "the 5th tool in the array I was sent" — they
			//      read our actual tool array correctly but format the call as
			//      an index instead of the name. Map back: name[N] resolves to
			//      the N-th registered tool. The model's mental model exactly
			//      matches our array order because it reads our request body.
			//   4. Anything still unmatched routes to the `invalid` pseudo-tool.
			// Without stages 1+2+3 the SDK would throw NoSuchToolError for
			// recoverable names. Pattern from Kilo Code (extended with stage 3).
			experimental_repairToolCall: async ({ toolCall, tools: registeredTools, error }) => {
				if (!registeredTools) return null;
				const raw = (toolCall as { toolName?: string }).toolName ?? '';
				const lowered = raw.toLowerCase();
				// Stage 1: lowercase exact match.
				if (raw && lowered !== raw && Object.prototype.hasOwnProperty.call(registeredTools, lowered)) {
					return { ...toolCall, toolName: lowered } as typeof toolCall;
				}
				// Stage 2: cross-ecosystem alias lookup.
				const aliasTarget = TOOL_NAME_ALIASES[lowered];
				if (aliasTarget && Object.prototype.hasOwnProperty.call(registeredTools, aliasTarget)) {
					return { ...toolCall, toolName: aliasTarget } as typeof toolCall;
				}
				// Stage 3: positional fallback for numeric tool names.
				const numericMatch = /^(\d+)$/.exec(raw);
				if (numericMatch) {
					const idx = parseInt(numericMatch[1], 10);
					const toolNames = Object.keys(registeredTools).filter(k => k !== INVALID_TOOL_NAME);
					if (idx >= 0 && idx < toolNames.length) {
						return { ...toolCall, toolName: toolNames[idx] } as typeof toolCall;
					}
				}
				// Stage 4: route to `invalid` pseudo-tool.
				const errMsg = (error as { message?: string } | undefined)?.message ?? 'Unknown tool name';
				return {
					...toolCall,
					toolName: INVALID_TOOL_NAME,
					input: JSON.stringify({ tool: raw, error: errMsg }),
				} as typeof toolCall;
			},
		});

		for await (const part of result.fullStream as AsyncIterable<TextStreamPart<any>>) {
			if (timeoutFired) break;

			switch (part.type) {
				case 'text-delta': {
					markFirstToken();
					fullTextSoFar += (part as any).text ?? '';
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'reasoning-delta': {
					markFirstToken();
					fullReasoningSoFar += (part as any).text ?? '';
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'tool-input-start': {
					// Single-slot accumulator (parity with existing _sendOpenAICompatibleChat).
					// Additional tool calls in the same response are intentionally ignored
					// — the consumer pipeline downstream only handles one tool per turn.
					if (toolName) break;
					toolName = (part as any).toolName ?? '';
					toolId = (part as any).id ?? '';
					markFirstToken();
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'tool-input-delta': {
					if (toolId && (part as any).id !== toolId) break;
					toolParamsStr += (part as any).delta ?? '';
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'tool-call': {
					// SDK delivers the fully-parsed input. Prefer it for the final call;
					// keeps us correct even when tool-input-delta wasn't emitted at all.
					if (!toolName && (part as any).toolName) {
						toolName = (part as any).toolName;
						toolId = (part as any).toolCallId ?? toolId;
					}
					const input = (part as any).input;
					if (input !== undefined) {
						try { toolParamsStr = JSON.stringify(input); }
						catch { /* keep accumulated */ }
					}
					break;
				}
				case 'finish-step':
				case 'finish': {
					lastFinishReason = (part as any).finishReason ?? lastFinishReason;
					// AI SDK v5+ (we are on `ai: ^6.0.182`) renamed `promptTokens`→`inputTokens`
					// and `completionTokens`→`outputTokens`. Old field names are kept as
					// fallback for any provider/path still on v4 shape. `finish-step` fires
					// per step (multi-step agentic loops), `finish` fires once at end — the
					// latter wins for totals; keep last seen on this combined branch.
					// Also try `totalUsage` (some SDK versions surface aggregate on `finish`
					// under a separate field).
					const u = ((part as any).usage ?? (part as any).totalUsage) as {
						inputTokens?: number; outputTokens?: number; totalTokens?: number;
						promptTokens?: number; completionTokens?: number;
					} | undefined;
					if (u) {
						const inTok = typeof u.inputTokens === 'number' ? u.inputTokens
							: typeof u.promptTokens === 'number' ? u.promptTokens : undefined;
						const outTok = typeof u.outputTokens === 'number' ? u.outputTokens
							: typeof u.completionTokens === 'number' ? u.completionTokens : undefined;
						const totTok = typeof u.totalTokens === 'number' ? u.totalTokens : undefined;
						if (typeof inTok === 'number' || typeof outTok === 'number' || typeof totTok === 'number') {
							lastUsage = {
								promptTokens: typeof inTok === 'number' ? inTok : lastUsage?.promptTokens,
								completionTokens: typeof outTok === 'number' ? outTok : lastUsage?.completionTokens,
								totalTokens: typeof totTok === 'number' ? totTok : lastUsage?.totalTokens,
							};
						}
						// One-time debug log: surface the exact shape returned by the
						// provider on the very first usage we see. Helps confirm field
						// names per provider without re-reading the SDK source. Cleared
						// once `lastUsage` is set so we don't spam.
						else {
							console.warn('[VibeIDE/usage] received but unrecognized shape', {
								part: part.type, keys: Object.keys(u), raw: u,
							});
						}
					}
					break;
				}
				case 'error': {
					throw (part as any).error;
				}
			}
		}

		if (timeoutFired) return;
		clearAllTimers();

		if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
			onError({
				message: buildEmptyResponseError(providerName, modelName, lastFinishReason ?? 'unknown'),
				fullError: null,
			});
			return;
		}

		const tc = finalizeToolCall();
		onFinalMessage({
			fullText: fullTextSoFar,
			fullReasoning: fullReasoningSoFar,
			anthropicReasoning: null,
			...(tc ? { toolCall: tc } : {}),
			...(lastUsage ? { usage: lastUsage } : {}),
		});
	} catch (error: any) {
		clearAllTimers();
		if (timeoutDeliveredPartial) return;
		if (abortController.signal.aborted && !timeoutFired) {
			// User-initiated abort — propagate nothing, the caller already knows.
			return;
		}
		const status = error?.statusCode ?? error?.status;
		if (status === 401) {
			onError({ message: `Invalid ${providerName} API key.`, fullError: error instanceof Error ? error : null });
		} else if (status === 429) {
			const msg = error?.message ?? 'Rate limit exceeded. Please wait a moment before trying again.';
			onError({ message: `Rate limit exceeded: ${msg}`, fullError: error instanceof Error ? error : null });
		} else {
			const msg = error?.message ?? String(error);
			onError({ message: msg, fullError: error instanceof Error ? error : null });
		}
	}
};
