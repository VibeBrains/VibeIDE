/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { InternalToolInfo } from './prompt/prompts.js';
import { ToolName, ToolParamName } from './toolsServiceTypes.js';
import { ChatMode, ModelSelection, ModelSelectionOptions, OverridesOfModel, ProviderName, RefreshableProviderName, SettingsOfProvider } from './vibeideSettingsTypes.js';


export const errorDetails = (fullError: Error | null): string | null => {
	if (fullError === null) {
		return null;
	}
	else if (typeof fullError === 'object') {
		if (Object.keys(fullError).length === 0) { return null; }
		return JSON.stringify(fullError, null, 2);
	}
	else if (typeof fullError === 'string') {
		return null;
	}
	return null;
};

export const getErrorMessage: (error: unknown) => string = (error) => {
	if (error instanceof Error) { return `${error.name}: ${error.message}`; }
	return error + '';
};

/**
 * Canonical "Empty response from provider/model" error message. Used by every
 * site that surfaces an empty-stream condition (`_sendOpenAICompatibleChat`,
 * `sendViaAISdk`, non-streaming paths) so the consumer in `chatThreadService`
 * (empty-response circuit breaker, Stage K) can parse provider/model out of
 * the string without inline regexes drifting per call-site.
 *
 * Keep the format STABLE — `parseEmptyResponseError` below depends on it.
 * Adding fields = append, never reorder.
 */
export const buildEmptyResponseError = (providerName: string, modelName: string, reason: string): string =>
	`VibeIDE: Empty response from ${providerName}/${modelName} (reason: ${reason}).`;

/**
 * Inverse of `buildEmptyResponseError`. Returns parsed (providerName, modelName)
 * if the message matches the template, else null. Used by the circuit breaker
 * to identify the failing combo without hardcoded provider/model names.
 *
 * Provider/model character class allows anything except `/` and whitespace —
 * matches what `buildEmptyResponseError` produces for any allowed provider id.
 */
export const parseEmptyResponseError = (message: string): { providerName: string; modelName: string } | null => {
	const m = message.match(/^VibeIDE: Empty response from ([^/\s]+)\/([^/\s]+) \(/);
	if (!m) { return null; }
	return { providerName: m[1], modelName: m[2] };
};

/**
 * Context-overflow signature patterns ported from opencode upstream
 * (`packages/opencode/src/provider/error.ts:11-31`). When an error message OR
 * a stream's reason field matches one of these, the actual cause is "input
 * exceeded the model's context window", not a generic "unknown" failure.
 *
 * Each pattern is annotated with the provider/model family that emits it —
 * the regex itself is intentionally permissive (case-insensitive substring),
 * so the same pattern matches across SDK adapters / aggregators.
 *
 * If a new pattern surfaces in the wild, add it here AND update the comment.
 */
export const OVERFLOW_PATTERNS: readonly RegExp[] = [
	/prompt is too long/i,                                  // Anthropic
	/input is too long for requested model/i,               // Amazon Bedrock
	/exceeds the context window/i,                          // OpenAI (Completions + Responses API message text)
	/input token count.*exceeds the maximum/i,              // Google (Gemini)
	/maximum prompt length is \d+/i,                        // xAI (Grok)
	/reduce the length of the messages/i,                   // Groq
	/maximum context length is \d+ tokens/i,                // OpenRouter, DeepSeek, vLLM
	/exceeds the limit of \d+/i,                            // GitHub Copilot
	/exceeds the available context size/i,                  // llama.cpp server
	/greater than the context length/i,                     // LM Studio
	/context window exceeds limit/i,                        // MiniMax
	/exceeded model token limit/i,                          // Kimi For Coding, Moonshot
	/context[_ ]length[_ ]exceeded/i,                       // Generic fallback
	/request entity too large/i,                            // HTTP 413
	/context length is only \d+ tokens/i,                   // vLLM
	/input length.*exceeds.*context length/i,               // vLLM
	/prompt too long; exceeded (?:max )?context length/i,   // Ollama explicit overflow error
	/too large for model with \d+ maximum context length/i, // Mistral
	/model_context_window_exceeded/i,                       // z.ai non-standard finish_reason surfaced as error text
];

/**
 * True if the provided text matches any known context-overflow signature.
 * Use on either an error.message string OR a finishReason / response-body
 * snippet. Returns false for empty / undefined input.
 */
export const isContextOverflow = (text: string | null | undefined): boolean => {
	if (!text) { return false; }
	return OVERFLOW_PATTERNS.some((p) => p.test(text));
};

/**
 * Specialized error message for context-window overflow. Distinct from
 * `buildEmptyResponseError` so the UI can show a "compact history" CTA
 * instead of a generic "try again" hint.
 *
 * Format is STABLE — `parseContextOverflowError` below depends on it.
 */
export const buildContextOverflowError = (providerName: string, modelName: string, detail?: string): string => {
	const tail = detail ? ` — ${detail}` : '';
	return `VibeIDE: Context overflow on ${providerName}/${modelName}${tail}. The chat exceeded the model's context window — compact the history or switch to a higher-context model.`;
};

/**
 * Inverse of `buildContextOverflowError`. Returns parsed (providerName, modelName)
 * if the message matches the template, else null. Lets `chatThreadService` and
 * UI surface model-specific guidance without inline regex drift.
 */
export const parseContextOverflowError = (message: string): { providerName: string; modelName: string } | null => {
	const m = message.match(/^VibeIDE: Context overflow on ([^/\s]+)\/([^/\s]+)/);
	if (!m) { return null; }
	return { providerName: m[1], modelName: m[2] };
};



export type AnthropicLLMChatMessage = {
	role: 'assistant';
	content: string | (AnthropicReasoning | { type: 'text'; text: string }
		| { type: 'tool_use'; name: string; input: Record<string, unknown>; id: string }
	)[];
} | {
	role: 'user';
	content: string | (
		{ type: 'text'; text: string } | { type: 'tool_result'; tool_use_id: string; content: string }
		| { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
	)[];
};
export type OpenAILLMChatMessage = {
	role: 'system' | 'developer';
	content: string;
} | {
	role: 'user';
	content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
} | {
	role: 'assistant';
	content: string | (AnthropicReasoning | { type: 'text'; text: string })[];
	tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string } }[];
} | {
	role: 'tool';
	content: string;
	tool_call_id: string;
};

export type GeminiLLMChatMessage = {
	role: 'model';
	parts: (
		| { text: string }
		| { functionCall: { id: string; name: ToolName; args: Record<string, unknown> } }
	)[];
} | {
	role: 'user';
	parts: (
		| { text: string }
		| { inlineData: { mimeType: string; data: string } }
		| { functionResponse: { id: string; name: ToolName; response: { output: string } } }
	)[];
};

export type LLMChatMessage = AnthropicLLMChatMessage | OpenAILLMChatMessage | GeminiLLMChatMessage;



export type LLMFIMMessage = {
	prefix: string;
	suffix: string;
	stopTokens: string[];
};


export type RawToolParamsObj = {
	[paramName in ToolParamName<ToolName>]?: string;
};
export type RawToolCallObj = {
	name: ToolName;
	rawParams: RawToolParamsObj;
	doneParams: ToolParamName<ToolName>[];
	id: string;
	isDone: boolean;
};

export type AnthropicReasoning = ({ type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string });

// Provider-normalized token usage from the LLM response. AI SDK exposes these as
// promptTokens / completionTokens / totalTokens; legacy OpenAI / Anthropic shapes
// map to the same fields when surfaced through `@ai-sdk/*` adapters. Optional —
// not every termination path (e.g. early timeout, abort) yields usage.
// `cachedInputTokens` — provider-reported prompt-cache hits (subset of promptTokens);
// surfaced so the TokenBudget log shows whether cache-friendly prompt assembly works
// (knowledge/roadmap/token-economy.md, A).
export type LLMTokenUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedInputTokens?: number };

export type OnText = (p: { fullText: string; fullReasoning: string; toolCall?: RawToolCallObj }) => void;
export type OnFinalMessage = (p: { fullText: string; fullReasoning: string; toolCall?: RawToolCallObj; anthropicReasoning: AnthropicReasoning[] | null; usage?: LLMTokenUsage }) => void; // id is tool_use_id
export type OnError = (p: { message: string; fullError: Error | null }) => void;
export type OnAbort = () => void;
export type AbortRef = { current: (() => void) | null };


// service types
type SendLLMType = {
	messagesType: 'chatMessages';
	messages: LLMChatMessage[]; // the type of raw chat messages that we send to Anthropic, OAI, etc
	separateSystemMessage: string | undefined;
	chatMode: ChatMode | null;
} | {
	messagesType: 'FIMMessage';
	messages: LLMFIMMessage;
	separateSystemMessage?: undefined;
	chatMode?: undefined;
};
export type ServiceSendLLMMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	logging: { loggingName: string; loggingExtras?: { [k: string]: unknown } };
	modelSelection: ModelSelection | null;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;
	onAbort: OnAbort;
	/** Per-turn: request `tool_choice: 'required'` for this send (agent-loop corrective nudge). */
	forceToolUse?: boolean;
} & SendLLMType;

/**
 * Tunable runtime knobs gathered from VS Code configuration on the renderer side
 * and passed through IPC. All fields optional — impl falls back to its own defaults
 * if a value is missing (defensive: lets us add more knobs without breaking older
 * IPC payloads).
 */
export type LLMRuntimeOptions = {
	timeoutMs?: {
		local?: number;
		cloud?: number;
		aggregator?: number;
		/** Inter-token idle timeout (ms): abort if the stream goes silent AFTER it has started
		 * emitting content. Default 45000. Does NOT cover the silent pre-content reasoning warmup
		 * (only the overall cap bounds that). See `vibeide.llm.timeoutMs.streamIdle`. */
		streamIdle?: number;
		/** Connection timeout (ms): abort if NO stream part of any kind arrives. Default 90000.
		 * Cleared by the first part, so a connected-but-thinking model is not cut off. See
		 * `vibeide.llm.timeoutMs.connection`. */
		connection?: number;
	};
	/** DEPRECATED in favor of `toolFallbackMode`. When false, force XML-in-prompt
	 * mode for aggregator-provider unknown models (overrides the synthesized
	 * `specialToolFormat='openai-style'` default). See `vibeide.llm.assumeNativeTools`. */
	assumeNativeTools?: boolean;
	/** Strategy for tool-call format on aggregator-routed unknown models.
	 * `auto` — start native, runtime auto-downgrade to XML on quirks.
	 * `native` — always force native FC, ignore any auto-detected overrides.
	 * `xml` — always force XML-in-prompt.
	 * Maps from `vibeide.llm.toolFallbackMode` setting (with backward-compat
	 * migration from `assumeNativeTools`). See roadmap O.8. */
	toolFallbackMode?: 'auto' | 'native' | 'xml';
	/** Per-turn force: when true, send `tool_choice: 'required'` so the model MUST emit a tool
	 * call instead of ending the turn with prose. Set by the agent loop on the corrective
	 * autopilot nudge (weak tool-callers like MiniMax narrate «Завершаю» in text instead of
	 * calling `vibe_complete`). No effect in XML-fallback mode (no native `tools` are sent).
	 * Default off. See `vibeide.agent.forceToolUseOnNudge`. */
	forceToolUse?: boolean;
};

// params to the true sendLLMMessage function
export type SendLLMMessageParams = {
	onText: OnText;
	onFinalMessage: OnFinalMessage;
	onError: OnError;
	logging: { loggingName: string; loggingExtras?: { [k: string]: unknown } };
	abortRef: AbortRef;

	modelSelection: ModelSelection;
	modelSelectionOptions: ModelSelectionOptions | undefined;
	overridesOfModel: OverridesOfModel | undefined;

	settingsOfProvider: SettingsOfProvider;
	mcpTools: InternalToolInfo[] | undefined;
	runtimeOptions?: LLMRuntimeOptions;
} & SendLLMType;



// can't send functions across a proxy, use listeners instead
export type BlockedMainLLMMessageParams = 'onText' | 'onFinalMessage' | 'onError' | 'abortRef';
export type MainSendLLMMessageParams = Omit<SendLLMMessageParams, BlockedMainLLMMessageParams> & { requestId: string } & SendLLMType;

export type MainLLMMessageAbortParams = { requestId: string };

export type EventLLMMessageOnTextParams = Parameters<OnText>[0] & { requestId: string };
export type EventLLMMessageOnFinalMessageParams = Parameters<OnFinalMessage>[0] & { requestId: string };
export type EventLLMMessageOnErrorParams = Parameters<OnError>[0] & { requestId: string };

// service -> main -> internal -> event (back to main)
// (browser)









// These are from 'ollama' SDK
interface OllamaModelDetails {
	parent_model: string;
	format: string;
	family: string;
	families: string[];
	parameter_size: string;
	quantization_level: string;
}

export type OllamaModelResponse = {
	name: string;
	modified_at: Date;
	size: number;
	digest: string;
	details: OllamaModelDetails;
	expires_at: Date;
	size_vram: number;
};

export type OpenaiCompatibleModelResponse = {
	id: string;
	created: number;
	object: 'model';
	owned_by: string;
};



// params to the true list fn
export type ModelListParams<ModelResponse> = {
	providerName: ProviderName;
	settingsOfProvider: SettingsOfProvider;
	onSuccess: (param: { models: ModelResponse[] }) => void;
	onError: (param: { error: string }) => void;
};

// params to the service
export type ServiceModelListParams<modelResponse> = {
	providerName: RefreshableProviderName;
	onSuccess: (param: { models: modelResponse[] }) => void;
	onError: (param: { error: unknown }) => void;
};

type BlockedMainModelListParams = 'onSuccess' | 'onError';
export type MainModelListParams<modelResponse> = Omit<ModelListParams<modelResponse>, BlockedMainModelListParams> & { providerName: RefreshableProviderName; requestId: string };

export type EventModelListOnSuccessParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onSuccess']>[0] & { requestId: string };
export type EventModelListOnErrorParams<modelResponse> = Parameters<ModelListParams<modelResponse>['onError']>[0] & { requestId: string };




