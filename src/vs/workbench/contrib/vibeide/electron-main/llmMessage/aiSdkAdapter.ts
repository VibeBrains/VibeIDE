/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import { googleThoughtSignatureOf, googleThoughtSignatureOptions } from '../../common/thoughtSignature.js';
import { vibeLog } from '../../common/vibeLog.js';
import { ANSWERED_MODEL_PEEK_CHARS, readServedIdentity } from '../../common/modelEcho.js';
import { OrchestrationTokens, orchestrationTokensOfTail, withOrchestration } from '../../common/orchestrationUsage.js';
import { streamText, generateText, jsonSchema, tool, type ModelMessage, type ToolSet, type TextStreamPart, type LanguageModel, type ToolCallRepairFunction } from 'ai';
import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { keyPlacement, VibeProviderEntry, VibeProviderProtocol, withQueryParams } from '../../common/vibeProvidersFile.js';
import type { DynProviderTransportConfig } from '../../common/vibeideSettingsService.js';
import { API_PROTOCOL_TO_SDK_NPM, ApiProtocolOverride, builtinWireSdkNpm, getIsReasoningEnabledState, getModelCapabilities, getProviderCapabilities, getReservedOutputTokenSpace, getSendableReasoningInfo, sdkNpmOfFileProtocol } from '../../common/modelCapabilities.js';

// Module-level memo for SDK-selection diagnostic logs. Keys are
// `${providerName}|${modelName}|${sdkNpm}|${source}` — log once per unique
// combo per process. Prevents per-request spam in long sessions while
// preserving the visibility we want on first use / on routing changes.
const _loggedSdkSelections = new Set<string>();
import { fetch as undiciFetch } from 'undici';
import type { JSONObject, JSONSchema7 } from '@ai-sdk/provider';
/* eslint-enable */

import { createHash } from 'crypto';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { availableTools, InternalToolInfo } from '../../common/prompt/prompts.js';
import { TOOL_NAME_ALIASES, applyParamAliases } from '../../common/prompt/toolAliases.js';
import { lenientJsonParseObject } from '../../common/lenientJson.js';
import { getModelSdkNpm } from './modelsDevCatalog.js';
import { buildContextOverflowError, buildEmptyResponseError, isContextOverflow, LLMChatMessage, LLMFinishNotice, LLMTokenUsage, ProviderRefusalDiagnostics, RawToolCallObj, RawToolParamsObj } from '../../common/sendLLMMessageTypes.js';
import { claudeThinkingOptions, compatibleClaudeThinkingOptions, DEFAULT_CLAUDE_THINKING_DISPLAY, googleThinkingConfig, openAIReasoningEffort } from '../../common/wireReasoning.js';
import { AnthropicReasoningCollector, finishNoticeOf } from '../../common/llmStreamFinish.js';
import { googleRetryDelaySecondsOf } from '../../common/googleRetryInfo.js';
import { stripUnknownContentBlocks } from '../../common/anthropicStrictBlocks.js';
import { isLocalProvider } from '../../common/isLocalProvider.js';
import { describeConnectionError } from '../../common/connectionErrorDiagnostics.js';
import { parseProviderQuotaHeaders, ProviderQuotaSnapshot } from '../../common/providerQuota.js';
import { ProviderRequestRateWindow } from '../../common/providerRequestRate.js';
import { readMiniMaxRefusal } from '../../common/minimaxBaseResp.js';
import { getModelQuirks } from '../modelQuirks/modelQuirksService.js';
import { withReasoningEffortInSystemPrompt } from '../../common/modelQuirks/modelQuirksTypes.js';
import { providerNames, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { ensureSystemCADispatcher } from './systemCAFetch.js';
import { extractReasoningWrapper, extractXMLToolsWrapper, stripThinkTagsWrapper, stripStandaloneThinkDelimitersWrapper } from './extractGrammar.js';
import type { SendChatParams_Internal } from './sendLLMMessage.internalTypes.js';
import { assertHttpHeaderSafe, getGoogleApiKey, withProcessEnvApiKey } from './llmHelpers.js';
import { detectNoFundsRefusal, noFundsStatusText } from '../../common/providerFundsRefusal.js';

// Every chat goes through this adapter: the built-ins by id, config providers (.vibe/providers) by
// their transport overlay. FIM and model listing keep their own paths in sendLLMMessage.impl.ts.
export type AiSdkProviderName =
	| 'anthropic' | 'openAI' | 'gemini'
	| 'openCodeGo' | 'openCodeZen' | 'openRouter' | 'minimax' | 'openAICompatible' | 'liteLLM' | 'lmRoute' | 'pollinations'
	| 'deepseek' | 'mistral' | 'xAI' | 'groq' | 'awsBedrock' | 'googleVertex' | 'microsoftAzure'
	| 'ollama' | 'vLLM' | 'lmStudio';

/**
 * Providers whose silence before the first visible token is bounded by `timeoutMs.aggregator`: the
 * extra hop client → aggregator → upstream adds latency. Config providers join them in `firstContentLimitMs`.
 */
const AGGREGATOR_PROVIDERS: ReadonlySet<string> = new Set(['openCodeGo', 'openCodeZen', 'openRouter', 'openAICompatible', 'liteLLM', 'lmRoute', 'pollinations']);

const BUILTIN_PROVIDERS: ReadonlySet<string> = new Set<string>(providerNames);
const isBuiltinProvider = (providerName: string): boolean => BUILTIN_PROVIDERS.has(providerName);

/** An OpenAI refusal to stream for an organisation that has not passed verification (reasoning models). */
const UNVERIFIED_ORG_STREAM_REFUSAL = /organization must be verified/i;

const EMPTY_CONTENT_PLACEHOLDER = '(no content)';

// Loose runtime shapes for the heterogeneous chat messages this adapter probes.
// `LLMChatMessage` is a discriminated union across three provider dialects
// (Anthropic / OpenAI / Gemini); the conversion below intentionally reads fields
// that live on different union members (e.g. `tool_calls` from the OpenAI shape
// AND `content[].type === 'tool_use'` from the Anthropic shape) on the same
// `msg`. Rather than narrow per-branch (which the runtime data does not cleanly
// support — messages arrive partially-normalized), we describe the superset of
// readable fields here and access through these optional-everything views.
interface ContentPartView {
	type?: string;
	text?: string;
	image_url?: { url?: string };
	source?: { data?: string; media_type?: string };
	tool_use_id?: string;
	content?: string | ContentPartView[];
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
	/** Anthropic `thinking` block. */
	thinking?: string;
	signature?: string;
	/** Anthropic `redacted_thinking` block. */
	data?: string;
}
interface ToolCallView {
	id?: string;
	function?: { name?: string; arguments?: string };
}
interface ChatMessageView {
	role?: string;
	content?: string | ContentPartView[];
	tool_calls?: ToolCallView[];
	tool_call_id?: string;
	reasoning_content?: string;
	reasoning?: string;
}

// AI SDK content-part element types, derived from the exported `ModelMessage`
// union (the underlying `UserContent` / `AssistantContent` aliases are not
// exported). Used to type the `parts` accumulators built per role below so they
// stay assignable to `ModelMessage.content` without `any`.
type ModelMessageOfRole<R extends string> = Extract<ModelMessage, { role: R }>;
type ContentArrayElement<R extends string> = Extract<ModelMessageOfRole<R>['content'], readonly unknown[]>[number];
type UserContentPart = ContentArrayElement<'user'>;
type AssistantContentPart = ContentArrayElement<'assistant'>;
// `providerOptions` carrier type, taken straight from the SDK message union so
// the prompt-cache breakpoint markers below stay assignable without `any`.
type MessageProviderOptions = NonNullable<ModelMessageOfRole<'system'>['providerOptions']>;

// Loose view over the heterogeneous error objects the AI SDK throws (retry
// wrappers, nested API-call errors, pre-parsed body). All fields optional and
// self-referential so the catch handler can probe `.lastError` / `.errors[]`
// for the real HTTP status without `any`.
interface AiSdkErrorView {
	message?: string;
	statusCode?: number;
	status?: number;
	responseHeaders?: Record<string, string>;
	responseBody?: string;
	data?: { error?: { message?: unknown } };
	lastError?: AiSdkErrorView;
	errors?: AiSdkErrorView[];
}

// IDs for opencode.ai aggregator headers. opencode CLI computes
// `x-opencode-project` from a workspace-stable source (`InstanceState.context.project.id`)
// and `x-opencode-session` per chat-session. We approximate:
//   - project: SHA-256 of `process.execPath` (= the Electron binary path of the
//     current VibeIDE install). Stable across IDE restarts on the same install,
//     so the aggregator's project-scoped cache / quota survives reopens. Different
//     installs / portable copies get different IDs — that's the intended grain.
//     We use `process.execPath` and NOT `__dirname` because this module is bundled
//     into ESM (`out/main.js` uses `--format=esm`) where `__dirname` is undefined;
//     using it crashes init_main with a TypeError on every cold start.
//   - session: per-process UUID (= "new IDE launch = new aggregator session"),
//     close enough to the per-chat-session grain at upstream without plumbing
//     chat-thread IDs through the main-process adapter layer.
// Note: `x-opencode-request` is generated per `resolveEndpoint()` call (one
// per streamText invocation) — see the openCodeGo branch below.
const OPENCODE_PROCESS_PROJECT_ID = `vibeide-${createHash('sha256').update(process.execPath).digest('hex').slice(0, 16)}`;
const OPENCODE_PROCESS_SESSION_ID = `vibeide-${generateUuid()}`;

// Model-family quirks (temperature/topP/topK presets, reasoning-content mirror,
// XML tool-format overrides) are no longer hardcoded here — they live in
// `resources/model-quirks.json`, served via CDN + bundled fallback, accessed
// via `getModelQuirks(modelId)` from the modelQuirksService. See
// docs/knowledge/architecture/modelQuirks.md.

// Per-model AI SDK adapter selection is fully data-driven via models.dev:
// see `modelsDevCatalog.ts`. No hardcoded model names / families / regex —
// the catalog returns the correct `@ai-sdk/*` package per (baseURL, modelName).
// New models (e.g. a hypothetical `maximax-m1`) get the right SDK automatically
// once they appear in models.dev; no code change required.

// Resolve the shared system-CA dispatcher PER REQUEST (inside customFetch), NOT
// captured once at module load: the «reset provider clients» diagnostic recreates
// the dispatcher to clear a wedged keep-alive pool ("no tokens until restart"), and
// a captured const would keep pinning the dead pool until process exit.

// 429s with a NOTICEABLE retry-after are NOT retryable in-place: AI SDK would burn its
// maxRetries backoff invisibly — no tokens flow during retries, so the renderer's
// hard-stall watchdog (120s) kills the stream mid-retry (observed: sonnet TPM saturation,
// «Стрим завис — нет токенов 120с» while retries were in progress). Re-statusing to 402
// (non-retryable per AI SDK's APICallError.isRetryable) surfaces the error in ~1s; the
// renderer's rate-limit auto-wait then pauses VISIBLY for the exact retry-after and
// resumes the turn. The response body/headers pass through untouched, so the provider's
// message and retry-after still reach the renderer. Only blip-throttles (retry-after
// missing or < 10s) keep the SDK's quick in-place retries.
const RATE_LIMIT_FAIL_FAST_RETRY_AFTER_SECONDS = 10;

/**
 * The status a response had before `makeCustomFetch` re-statused it. A 429 turned into 402 so the SDK stops
 * retrying is still a rate limit for everyone after it, and this header says so as a field: the vendor's
 * own words (Google: «Resource has been exhausted») need not mention a rate limit at all.
 */
const ORIGINAL_STATUS_HEADER = 'x-vibe-original-status';

// fetch wrapper that pins the corporate-CA-aware undici dispatcher. We cannot
// pass `dispatcher` directly to streamText() — AI SDK only accepts a standard
// fetch — so we wrap undici.fetch and surface it as a global-fetch lookalike.
// undici's fetch input/init types diverge from the DOM lib types the public
// `typeof globalThis.fetch` contract uses (undici Request vs DOM Request). The
// boundary conversion is genuinely cross-type, so it goes through `unknown` —
// the only place in this wrapper where a non-narrowing cast is unavoidable.
type UndiciFetchParams = Parameters<typeof undiciFetch>;

/**
 * Requests-per-window counter, shared across the process on purpose: the window belongs to the
 * API KEY, not to one turn, so subagents running concurrently must all count into the same
 * bucket. (Contrast with `onQuota` below, which is per-request by design.)
 */
const requestRateWindow = new ProviderRequestRateWindow();

/**
 * How much of the response body we keep while peeking for `base_resp`. MiniMax puts the refusal
 * near the end of a stream, so a bounded TAIL is enough and a runaway response cannot grow it.
 */
const REFUSAL_BODY_PEEK_LIMIT = 64 * 1024;

/**
 * Passes the body through untouched while keeping a bounded tail, so a refusal carried INSIDE a
 * successful-looking response can still be read. Mirrors rather than consumes: `tee()` would
 * need an active second reader (back-pressure), a `clone()` would double-buffer the whole
 * stream. Peeking must never break the stream — every failure here is swallowed.
 */
/**
 * Reads the model the provider says it served off the head of the answer, then leaves the stream
 * alone. Mirrors `observeBodyTail` and for the same reason: peeking must never break the body, so
 * every failure here is swallowed and the scan stops once the name is found or the head is spent.
 */
/** The `usage` field of a final message, or nothing when there is no usage at all. */
const usageField = (usage: LLMTokenUsage | undefined): { usage?: LLMTokenUsage } => usage ? { usage } : {};

const observeAnsweredModel = (response: Response, onModel: (model: string, fingerprint: string | undefined) => void): Response => {
	if (!response.body) { return response; }
	let head = '';
	let done = false;
	const decoder = new TextDecoder();
	const observer = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			if (done) { return; }
			try {
				const text = decoder.decode(chunk, { stream: true });
				if (!text) { return; }
				head = (head + text).slice(0, ANSWERED_MODEL_PEEK_CHARS);
				const served = readServedIdentity(head);
				if (served.model) { done = true; onModel(served.model, served.fingerprint); return; }
				if (head.length >= ANSWERED_MODEL_PEEK_CHARS) { done = true; }
			} catch { done = true; }
		},
	});
	return new Response(response.body.pipeThrough(observer), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
};

const observeBodyTail = (response: Response, onTail: (tail: string) => void): Response => {
	if (!response.body) { return response; }
	let tail = '';
	const decoder = new TextDecoder();
	const publish = () => { if (tail) { onTail(tail); } };
	const observer = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			try {
				const text = decoder.decode(chunk, { stream: true });
				if (!text) { return; }
				tail = (tail + text).slice(-REFUSAL_BODY_PEEK_LIMIT);
				// Parse only when the marker is actually in flight — a stream that never
				// mentions it costs one substring check per chunk. Publishing eagerly (rather
				// than only on flush) matters because an aborted stream never flushes.
				if (text.includes('base_resp')) { publish(); }
			} catch {
				// A malformed chunk must not take the real response down with it.
			}
		},
		flush() { publish(); },
	});
	try {
		return new Response(response.body.pipeThrough(observer), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch {
		// Re-wrapping can throw (e.g. a statusText outside Latin-1). Diagnostics are never
		// worth losing the response over.
		return response;
	}
};

const headersToRecord = (headers: Headers): Record<string, string> => {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
	return out;
};

// Built per call, not once per module: `onQuota` must land in the state of ITS OWN request.
// Subagents run several turns concurrently, so a module-level sink would attribute one
// provider's remaining quota to another provider's turn.
/**
 * How much of a refusal body to read before deciding. Vendor error JSON is a few hundred bytes;
 * the cap keeps a pathological error page from being pulled into memory in full.
 */
const REFUSAL_BODY_PEEK_CHARS = 4_000;

/**
 * Stands in for the key of a provider from a file — the SDK never gets the key itself
 * Every SDK insists on some key and puts it in its own header, while the file decides where the key goes (`keyPlacement`)
 * Given `undefined` an SDK reads OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY and sends the user's
 * real key to a server that asked for none; given `''` it sends an empty `Bearer `
 * So the SDK gets this marker, `makeCustomFetch` drops every header that carries it and places the key itself
 */
const FILE_KEY_MARKER = 'vibeide-file-provider-key';

/**
 * The request headers without any whose value carries `marker`
 * Matched by value, not by name: the SDKs name their key header differently, and headers the file declares never carry it
 */
const headersWithout = (headers: HeadersInit | undefined, marker: string): Record<string, string> => {
	const kept: Record<string, string> = {};
	new Headers(headers).forEach((value, name) => {
		if (!value.includes(marker)) {
			kept[name] = value;
		}
	});
	return kept;
};

/** The request's address with `params` appended; a `Request` object is left as it is — the SDKs pass a string */
const withQueryOnInput = (input: RequestInfo | URL, params: Readonly<Record<string, string>>): RequestInfo | URL => {
	if (Object.keys(params).length === 0) {
		return input;
	}
	return typeof input === 'string' ? withQueryParams(input, params) : input instanceof URL ? new URL(withQueryParams(input.href, params)) : input;
};

/**
 * The request headers without the SDK's key, with the key where `keyPlacement` put it
 * Header names are case-insensitive: a key header replaces a same-named one of the file instead of going out twice
 */
const withFileKeyHeaders = (headers: HeadersInit | undefined, keyHeaders: Readonly<Record<string, string>>): Record<string, string> => {
	const kept = headersWithout(headers, FILE_KEY_MARKER);
	const placed = new Set(Object.keys(keyHeaders).map(name => name.toLowerCase()));
	for (const name of Object.keys(kept)) {
		if (placed.has(name.toLowerCase())) {
			delete kept[name];
		}
	}
	return { ...kept, ...keyHeaders };
};

/** A JSON request body with `patch` merged over its top level; a body that is not a JSON object goes as it is */
const withBodyPatch = (body: string, patch: Readonly<Record<string, unknown>>): string => {
	try {
		const parsed: unknown = JSON.parse(body);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify({ ...parsed, ...patch }) : body;
	} catch {
		return body;
	}
};

/** The wire a request speaks, by the SDK chosen for it — what decides the default place of a file provider's key */
function wireOfSdkNpm(sdkNpm: string | undefined): VibeProviderProtocol {
	switch (sdkNpm) {
		case '@ai-sdk/anthropic': return 'anthropic';
		case '@ai-sdk/google': return 'gemini';
		case '@ai-sdk/openai#responses': return 'openai-responses';
		default: return 'openai';
	}
}

const makeCustomFetch = (opts: {
	providerName: string;
	/**
	 * A provider from a file: headers carrying `FILE_KEY_MARKER` are removed, and the key goes where `keyPlacement` put it
	 * The file's own query parameters ride along on every request
	 */
	fileKey?: { readonly headers: Readonly<Record<string, string>>; readonly query: Readonly<Record<string, string>> };
	/**
	 * Fields merged into the JSON body — a file model's `extraBody` and its «off» on a wire whose SDK takes no
	 * body transform (Anthropic); the OpenAI-compatible wire gets the same through `transformRequestBody`
	 */
	bodyPatch?: Readonly<Record<string, unknown>>;
	onQuota?: (snapshot: ProviderQuotaSnapshot) => void;
	/** The model named in the answer — a proxy or a failover target may serve a different one. */
	onAnsweredModel?: (model: string, fingerprint: string | undefined) => void;
	/** Orchestration tokens found at the end of the answer — see common/orchestrationUsage.ts. */
	onOrchestrationTokens?: (tokens: OrchestrationTokens) => void;
	/**
	 * Called with what the provider said, as soon as we know it. Fires up to twice per request:
	 * once on the headers, again if a `base_resp` refusal turns up in the body. Last call wins.
	 */
	onDiagnostics?: (diagnostics: ProviderRefusalDiagnostics) => void;
}): typeof globalThis.fetch => async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const requestsInWindow = requestRateWindow.record(opts.providerName, Date.now());
	const fileKey = opts.fileKey;
	const undiciInput = (fileKey ? withQueryOnInput(input, fileKey.query) : input) as unknown as UndiciFetchParams[0];
	const keyed = fileKey ? { ...init, headers: withFileKeyHeaders(init?.headers, fileKey.headers) } : init;
	const outgoing = opts.bodyPatch && typeof keyed?.body === 'string' ? { ...keyed, body: withBodyPatch(keyed.body, opts.bodyPatch) } : keyed;
	const undiciInit = { ...(outgoing as unknown as UndiciFetchParams[1]), dispatcher: ensureSystemCADispatcher() };
	const response = await (undiciFetch(undiciInput, undiciInit) as unknown as Promise<Response>);
	// Cloned HERE, before the diagnostics tap below starts consuming the stream: `clone()` throws
	// once the body has been read, and the funds check further down needs the text. Refusals only —
	// a success body must stay a single un-teed stream.
	const refusalPeek = response.status >= 400 && response.status < 500 ? response.clone() : undefined;
	const observedAt = Date.now();
	// Every response carries the key's remaining allowance, not just refusals — that is the
	// whole point of reading it here instead of at the 429 branch below.
	const snapshot = parseProviderQuotaHeaders(response.headers, observedAt);
	if (snapshot && opts.onQuota) { opts.onQuota(snapshot); }

	const { onDiagnostics } = opts;
	let observed = response;
	if (onDiagnostics) {
		// Baseline first: even when the body says nothing, the status, the headers and the
		// observed rate answer "were we anywhere near the published limit?".
		const baseline: ProviderRefusalDiagnostics = {
			httpStatus: response.status,
			headers: headersToRecord(response.headers),
			requestsInWindow,
			windowSeconds: requestRateWindow.windowSeconds,
			...(snapshot ? { quota: snapshot } : {}),
			observedAt,
		};
		onDiagnostics(baseline);
		observed = observeBodyTail(response, tail => {
			const refusal = readMiniMaxRefusal(tail);
			if (!refusal || refusal.kind === 'ok') { return; }
			onDiagnostics({
				...baseline,
				bodyCode: refusal.code,
				...(refusal.message ? { bodyMessage: refusal.message } : {}),
				refusalKind: refusal.kind,
				refusalAmbiguous: refusal.ambiguous,
			});
		});
	}

	if (opts.onAnsweredModel) {
		const onAnsweredModel = opts.onAnsweredModel;
		observed = observeAnsweredModel(observed, (model, fingerprint) => onAnsweredModel(model, fingerprint));
	}

	// An orchestrator bills its internal calls on top of the visible tokens, and the SDK drops those
	// fields. They arrive with the final usage, at the END of the answer — the head peek above never
	// sees them, so the tail is watched instead. A body that never mentions them costs one substring
	// check per chunk and nothing else.
	if (opts.onOrchestrationTokens && response.ok) {
		const onOrchestrationTokens = opts.onOrchestrationTokens;
		observed = observeBodyTail(observed, tail => {
			const tokens = orchestrationTokensOfTail(tail);
			if (tokens) { onOrchestrationTokens(tokens); }
		});
	}

	// The headers the rest of this function and the SDK see. Replaced only to carry a delay the vendor
	// put in the body instead of in `retry-after` (Google, below).
	let responseHeaders = response.headers;

	// "Out of funds" must not be retried: the answer cannot change until money is added or the
	// endpoint is corrected, yet vendors return it as 429 and the SDK dutifully waits out five
	// backoffs (observed live: six attempts over a minute against Z.AI code 1113). Read the body
	// on refusals only — it is short there, and a success body must stay a stream.
	if (refusalPeek) {
		let bodyText: string | undefined;
		try {
			bodyText = (await refusalPeek.text()).slice(0, REFUSAL_BODY_PEEK_CHARS);
		} catch {
			// Unreadable body: fall through to the normal paths rather than guessing.
		}
		// Gemini and Vertex name the wait in a RetryInfo detail, never in the header. Lifted into the
		// header so the fail-fast rule below and the chat's rate-limit pause wait the time the vendor asked
		// for instead of a guessed default.
		if (response.status === 429 && !response.headers.get('retry-after')) {
			const delaySeconds = googleRetryDelaySecondsOf(bodyText);
			if (delaySeconds !== undefined) {
				responseHeaders = new Headers(response.headers);
				responseHeaders.set('retry-after', String(Math.ceil(delaySeconds)));
			}
		}
		const funds = detectNoFundsRefusal(response.status, bodyText);
		if (funds.isNoFunds) {
			vibeLog.warn('aiSdkAdapter', `[${opts.providerName}] провайдер сообщает об отсутствии средств${funds.vendorCode ? ` (код ${funds.vendorCode})` : ''} — повторы отключены для этого запроса`);
			// 402 rather than the original status: the SDK retries 429 and does not retry 402, and
			// this is exactly the neighbouring trick used for a too-distant retry-after below.
			return new Response(bodyText ?? null, {
				status: 402,
				statusText: noFundsStatusText(funds),
				headers: response.headers,
			});
		}
	}

	if (response.status === 429) {
		const retryAfterSec = Number(responseHeaders.get('retry-after'));
		if (Number.isFinite(retryAfterSec) && retryAfterSec >= RATE_LIMIT_FAIL_FAST_RETRY_AFTER_SECONDS) {
			const restatusedHeaders = new Headers(responseHeaders);
			restatusedHeaders.set(ORIGINAL_STATUS_HEADER, '429');
			// NOTE: statusText is a ByteString (Latin-1 only) — non-ASCII characters here
			// make the Response constructor itself throw (observed with an em-dash).
			return new Response(observed.body, {
				status: 402,
				statusText: 'Payment Required (quota exhausted, retry-after too distant to retry)',
				headers: restatusedHeaders,
			});
		}
		if (responseHeaders !== response.headers) {
			return new Response(observed.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
		}
	}
	return observed;
};

/** A safety classifier's refusal, named with its category when the vendor gives one. */
const refusalMessage = (modelName: string, category: string | undefined, explanation: string | undefined): string =>
	`Модель ${modelName} отказалась отвечать: сработал фильтр безопасности вендора${category ? ` (${category})` : ''}.${explanation ? ` ${explanation}` : ''}`;

/** Every piece of text an SDK error carries: the wrapper, the nested API error, the raw body. */
const errorTextOf = (error: unknown): string => {
	const view = (error ?? {}) as AiSdkErrorView;
	const inner = view.lastError ?? (Array.isArray(view.errors) && view.errors.length > 0 ? view.errors[view.errors.length - 1] : undefined);
	return [view.message, view.responseBody, inner?.message, inner?.responseBody].filter((part): part is string => typeof part === 'string').join('\n');
};

/** Token usage of a whole non-streamed answer, in the shape `onFinalMessage` carries. */
const usageOfTotals = (usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; inputTokenDetails?: { cacheWriteTokens?: number } }): LLMTokenUsage => ({
	promptTokens: usage.inputTokens,
	completionTokens: usage.outputTokens,
	totalTokens: usage.totalTokens,
	cachedInputTokens: usage.cachedInputTokens,
	cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens,
});

/** Why a tool call was not run: the stream stopped before the model finished its arguments. */
const cutToolCallMessage = (toolName: string, reason: string): string =>
	`${reason} Вызов инструмента «${toolName}» оборван посреди аргументов и не выполнен.`;

/** A reply cut by the output limit in the middle of a tool call. */
const TRUNCATED_TOOL_CALL_REASON = 'Ответ упёрся в лимит вывода модели.';

/** Where `cacheWriteTokensExtractor` leaves what it read, next to the SDK's own provider metadata. */
const USAGE_METADATA_KEY = 'vibeUsage';

const cacheWriteTokensOf = (usage: unknown): number | undefined => {
	const writes = (usage as { prompt_tokens_details?: { cache_write_tokens?: unknown } } | undefined)?.prompt_tokens_details?.cache_write_tokens;
	return typeof writes === 'number' && writes >= 0 ? writes : undefined;
};

/**
 * Cache WRITES on the OpenAI-compatible wire. OpenAI reports them as
 * `usage.prompt_tokens_details.cache_write_tokens` (a part of `prompt_tokens`), and
 * @ai-sdk/openai-compatible 2.0.x does not read the field, so every write was billed at the fresh-input
 * rate — on GPT-6 a write costs a quarter more than input. The native OpenAI SDK reads it; this reads it
 * for everyone else.
 */
const cacheWriteTokensExtractor: MetadataExtractor = {
	extractMetadata: async ({ parsedBody }) => {
		const writes = cacheWriteTokensOf((parsedBody as { usage?: unknown } | undefined)?.usage);
		return writes !== undefined ? { [USAGE_METADATA_KEY]: { cacheWriteTokens: writes } } : undefined;
	},
	createStreamExtractor: () => {
		let writes: number | undefined;
		return {
			processChunk: chunk => { writes = cacheWriteTokensOf((chunk as { usage?: unknown } | undefined)?.usage) ?? writes; },
			buildMetadata: () => writes !== undefined ? { [USAGE_METADATA_KEY]: { cacheWriteTokens: writes } } : undefined,
		};
	},
};

const parseHeadersJSON = (s: string | undefined): Record<string, string> | undefined => {
	if (!s) { return undefined; }
	try {
		const obj: unknown = JSON.parse(s);
		if (obj && typeof obj === 'object') {
			const record = obj as Record<string, unknown>;
			const out: Record<string, string> = {};
			for (const k of Object.keys(record)) {
				const v = record[k];
				if (typeof v === 'string') { out[k] = v; }
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
	/**
	 * A provider from a file: `apiKey` is `FILE_KEY_MARKER`, and the key is placed per request by `keyPlacement` once the
	 * request's wire is known — a model may speak another wire than its provider
	 */
	fileKey?: {
		/** The file's `auth` as the merged layers wrote it; absent — the wire's own header */
		readonly auth: VibeProviderEntry['auth'];
		/** No key at all sends nothing: no placeholder, no key from the environment */
		readonly key: string | undefined;
		readonly query?: Readonly<Record<string, string>>;
	};
	/** How long the server may stay silent before it starts answering — the file's `timeoutMs` */
	timeoutMs?: number;
};

const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Anthropic's base URL from `ANTHROPIC_BASE_URL`. The official SDK read that variable WITHOUT the version
 * segment and appended `/v1/messages`; @ai-sdk/anthropic appends only `/messages`. A value written for the
 * old client gets its `/v1` back instead of silently becoming a 404.
 */
function anthropicBaseURLOf(fromEnv: string | undefined): string {
	const trimmed = fromEnv?.trim().replace(/\/+$/, '');
	if (!trimmed) {
		return ANTHROPIC_DEFAULT_BASE_URL;
	}
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

// Resolve baseURL/apiKey/headers/queryParams per provider. The one place chat
// endpoints live — any change here re-routes every request to that provider.
const resolveEndpoint = async (
	providerName: AiSdkProviderName,
	modelName: string,
	settingsOfProvider: SettingsOfProvider,
): Promise<ResolvedEndpoint> => {
	switch (providerName) {
		// ---------- Vendors' own APIs ----------
		// The base URLs honour the vendor SDKs' environment variables, as the official clients these routes
		// replaced did: a corporate gateway configured that way keeps working.
		case 'anthropic': {
			return { baseURL: anthropicBaseURLOf(process.env.ANTHROPIC_BASE_URL), apiKey: settingsOfProvider.anthropic?.apiKey ?? '' };
		}
		case 'openAI': {
			return { baseURL: (process.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, ''), apiKey: settingsOfProvider.openAI?.apiKey ?? '' };
		}
		case 'gemini': {
			return { baseURL: GEMINI_DEFAULT_BASE_URL, apiKey: settingsOfProvider.gemini?.apiKey ?? '' };
		}
		// ---------- Local servers ----------
		case 'ollama':
		case 'vLLM':
		case 'lmStudio': {
			const endpoint = (settingsOfProvider[providerName]?.endpoint ?? '').replace(/\/+$/, '');
			return { baseURL: endpoint ? `${endpoint}/v1` : '', apiKey: 'noop' };
		}
		// ---------- Aggregators ----------
		case 'openCodeGo': {
			const c = settingsOfProvider.openCodeGo;
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
			// Same rationale as openCodeGo — see comment above.
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
			// `x-session-affinity` is the non-opencode-namespaced sibling of
			// `x-opencode-session` — opencode upstream sends it on every aggregator
			// path that's NOT their own (see request.ts:178-181). Sticky-session
			// routing hint for the aggregator's edge: same-session requests go to
			// the same backend pod, preserving in-flight context / KV-cache.
			return {
				baseURL: 'https://openrouter.ai/api/v1',
				apiKey: c?.apiKey ?? '',
				headers: {
					'HTTP-Referer': 'https://vibeide.com',
					'X-Title': 'VibeIDE',
					'x-session-affinity': OPENCODE_PROCESS_SESSION_ID,
				},
			};
		}
		case 'openAICompatible': {
			const c = settingsOfProvider.openAICompatible;
			const headers = parseHeadersJSON(c?.headersJSON) ?? {};
			for (const [hName, hValue] of Object.entries(headers)) {
				assertHttpHeaderSafe(`OpenAI-Compatible custom header name "${hName}"`, hName);
				if (typeof hValue === 'string') {
					assertHttpHeaderSafe(`OpenAI-Compatible custom header "${hName}" value`, hValue);
				}
			}
			// Inject session affinity for aggregator routes. User-supplied headers
			// win on collision (Object.assign order below) — they may already set
			// their own affinity key for a private gateway.
			return {
				baseURL: c?.endpoint ?? '',
				apiKey: c?.apiKey ?? '',
				headers: { 'x-session-affinity': OPENCODE_PROCESS_SESSION_ID, ...headers },
			};
		}
		case 'liteLLM': {
			const c = settingsOfProvider.liteLLM;
			const endpoint = (c?.endpoint ?? '').replace(/\/+$/, '');
			return {
				baseURL: `${endpoint}/v1`,
				apiKey: c?.apiKey || 'noop',
				headers: { 'x-session-affinity': OPENCODE_PROCESS_SESSION_ID },
			};
		}
		case 'lmRoute': {
			const c = settingsOfProvider.lmRoute;
			// Endpoint includes the version segment as-is (e.g. .../openai/v1).
			return {
				baseURL: c?.endpoint ?? '',
				apiKey: c?.apiKey || 'noop',
				headers: { 'x-session-affinity': OPENCODE_PROCESS_SESSION_ID },
			};
		}
		case 'pollinations': {
			const c = settingsOfProvider.pollinations;
			return {
				baseURL: 'https://gen.pollinations.ai/v1',
				apiKey: c?.apiKey ?? '',
				headers: { 'x-session-affinity': OPENCODE_PROCESS_SESSION_ID },
			};
		}
		// ---------- Direct cloud OpenAI-compat ----------
		case 'deepseek': {
			const c = settingsOfProvider.deepseek;
			return { baseURL: 'https://api.deepseek.com/v1', apiKey: c?.apiKey ?? '' };
		}
		case 'minimax': {
			// Vanilla OpenAI-compatible — no custom headers. See how it behaves out of the box.
			const c = settingsOfProvider.minimax;
			return { baseURL: 'https://api.minimax.io/v1', apiKey: c?.apiKey ?? '' };
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
			if (!baseURL.endsWith('/v1')) { baseURL = baseURL.replace(/\/+$/, '') + '/v1'; }
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
		// ---------- Dynamic providers (.vibe/providers.json) ----------
		default: {
			// Not a built-in id. Its transient transport (baseURL/apiKey/apiKeyEnv/headers) was merged
			// into `settingsOfProvider` on the send-site (2b-2 C overlay). apiKey was already resolved
			// in the renderer from apiKeyRef/.vibe/.env; apiKeyEnv resolves HERE as the last fallback
			// (electron-main has reliable process.env). Empty baseURL → caller's guard surfaces a clear
			// error (PRODUCT invariant 3). Mirror of the openai-compatible fallthrough in
			// `newOpenAICompatibleSDK` (sendLLMMessage.impl.ts), but for the AI-SDK path.
			const cfg = (settingsOfProvider as unknown as Record<string, DynProviderTransportConfig | undefined>)[providerName as string];
			const headers = (cfg?.headers && typeof cfg.headers === 'object') ? cfg.headers : undefined;
			if (headers) {
				for (const [hName, hValue] of Object.entries(headers)) {
					assertHttpHeaderSafe(`Dynamic provider "${providerName}" header name "${hName}"`, hName);
					if (typeof hValue === 'string') { assertHttpHeaderSafe(`Dynamic provider "${providerName}" header "${hName}" value`, hValue); }
				}
			}
			// A keyless server gets no key; any other one gets the key it has, or nothing — never a placeholder
			const key = cfg?.keyless ? undefined : cfg?.apiKey || (cfg?.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined) || undefined;
			if (key) { assertHttpHeaderSafe(`Dynamic provider "${providerName}" API key`, key); }
			return {
				baseURL: cfg?.baseURL ?? '',
				apiKey: FILE_KEY_MARKER,
				headers,
				fileKey: { auth: cfg?.auth, key, ...(cfg?.query ? { query: cfg.query } : {}) },
				...(cfg?.timeoutMs ? { timeoutMs: cfg.timeoutMs } : {}),
			};
		}
	}
};

// Look up tool name for a tool_call_id by scanning prior assistant tool_calls.
// AI SDK's ToolResultPart requires toolName, which our message format does not carry.
const buildToolNameLookup = (messages: LLMChatMessage[]): Map<string, string> => {
	const map = new Map<string, string>();
	for (const msg of messages as ChatMessageView[]) {
		if (msg?.role !== 'assistant') { continue; }
		// OpenAI shape: assistant.tool_calls[].
		if (Array.isArray(msg.tool_calls)) {
			for (const tc of msg.tool_calls) {
				if (tc?.id && tc?.function?.name) { map.set(tc.id, tc.function.name); }
			}
		}
		// Anthropic shape: assistant.content[] with { type: 'tool_use', id, name } blocks.
		// (The renderer emits this shape for anthropic-protocol routes — e.g. sonnet via
		// openCodeGo Zen /v1/messages. Without this branch the lookup stayed empty and the
		// whole tool history was silently dropped below — see the get_dir_tree replay bug.)
		if (Array.isArray(msg.content)) {
			for (const p of msg.content) {
				if (p?.type === 'tool_use' && typeof p?.id === 'string' && typeof p?.name === 'string') { map.set(p.id, p.name); }
			}
		}
	}
	return map;
};

const flattenTextContent = (c: string | ContentPartView[] | undefined): string => {
	if (typeof c === 'string') { return c; }
	if (Array.isArray(c)) {
		return c
			.map(p => (p?.type === 'text' && typeof p?.text === 'string') ? p.text : '')
			.join('');
	}
	return '';
};

// LLMChatMessage[] -> AI SDK ModelMessage[]. Anthropic's signed thinking blocks
// go back only on the Anthropic wire (`anthropicWire`), as reasoning parts carrying
// their signature — the vendor verifies each one. Everywhere else they are dropped:
// other wires do not accept them on input.
//
// `modelName` is consulted for family-specific normalization:
//   - DeepSeek: force an empty `{ type: 'reasoning', text: '' }` placeholder on
//     every assistant turn that lacks one. DeepSeek's API rejects continuations
//     where any past assistant message is missing the reasoning slot (HTTP 400
//     "reasoning_content must be passed back"). opencode CLI does the same —
//     `provider/transform.ts:286-301`.
//   - Interleaved reasoning families (DeepSeek, MiniMax-m2, Kimi-k2-thinking):
//     additionally mirror the combined reasoning text onto
//     `providerOptions.openaiCompatible.reasoning_content` at the message level.
//     AI SDK's openai-compatible adapter serializes per-message providerOptions
//     into the request body; without this mirror, the upstream sees content[]
//     reasoning parts but not the top-level `reasoning_content` field that
//     these providers actually read. `transform.ts:303-336`.
/**
 * The system prompt of a call: the renderer's system and developer messages, then the separate one
 * The renderer puts the prompt into the message list for every model whose capability is `system-role` or `developer-role`
 * (all but Anthropic's own), and the message conversion below drops such messages — the prompt must be taken from here,
 * or the model gets no rules, no workspace facts and no instructions at all
 * The AI SDK places the result the way each wire wants it; OpenAI's reasoning models get it as `developer` from the SDK itself
 */
function systemPromptOf(separateSystemMessage: string | undefined, messages: readonly LLMChatMessage[]): string | undefined {
	const parts: string[] = [];
	for (const message of messages) {
		if ((message.role === 'system' || message.role === 'developer') && message.content.trim()) {
			parts.push(message.content);
		}
	}
	if (separateSystemMessage?.trim()) {
		parts.push(separateSystemMessage);
	}
	return parts.length > 0 ? parts.join('\n\n') : undefined;
}

const convertMessagesToModelMessages = (messages: LLMChatMessage[], modelName: string, providerName: string, anthropicWire: boolean): ModelMessage[] => {
	const toolNameLookup = buildToolNameLookup(messages);
	const lastIdx = messages.length - 1;
	const out: ModelMessage[] = [];
	// Family-specific normalization comes from the model-quirks catalog (was hardcoded
	// before v0.13.6). Empty quirks → both flags `false` → no special handling, same as
	// for a model with no known quirks.
	const quirks = getModelQuirks(modelName, providerName);
	// `forceEmptyReasoning` quirk — misnamed `isDeepseek` historically, but it's not
	// deepseek-specific: any interleaved-reasoning family (deepseek, minimax-m2, kimi-thinking)
	// needs the empty-reasoning slot roundtrip. Driven purely by the quirk flag.
	const forceEmptyReasoningSlot = quirks.forceEmptyReasoning === true;
	const needsInterleavedMirror = quirks.mirrorReasoningContent === true;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i] as ChatMessageView;
		const isLastAndAssistant = i === lastIdx && msg.role === 'assistant';
		const role = msg.role;

		if (role === 'system' || role === 'developer') {
			// The call's system prompt carries their text (`systemPromptOf`): the AI SDK places it the way each wire
			// wants it, on @ai-sdk/anthropic in the request's top-level `system` field
			continue;
		}

		if (role === 'user') {
			const content = msg.content;
			if (typeof content === 'string') {
				out.push({ role: 'user', content: content.trim() ? content : EMPTY_CONTENT_PLACEHOLDER });
			} else if (Array.isArray(content)) {
				const parts: UserContentPart[] = [];
				for (const p of content) {
					if (p?.type === 'text' && typeof p?.text === 'string') {
						parts.push({ type: 'text', text: p.text });
					} else if (p?.type === 'image_url' && p?.image_url?.url) {
						const url: string = p.image_url.url;
						try { parts.push({ type: 'image', image: new URL(url) }); }
						catch { parts.push({ type: 'image', image: url }); }
					} else if (p?.type === 'image' && p?.source?.data) {
						// Anthropic image shape: { type: 'image', source: { type: 'base64', media_type, data } }.
						parts.push({ type: 'image', image: p.source.data, ...(p.source.media_type ? { mediaType: p.source.media_type } : {}) });
					} else if (p?.type === 'tool_result' && typeof p?.tool_use_id === 'string') {
						// Anthropic shape carries tool results as user-content blocks. AI SDK wants a
						// dedicated `role: 'tool'` message. These were silently DROPPED before — the
						// model saw empty user turns instead of its tool outputs and re-issued the
						// same call forever (observed: sonnet via openCodeGo Zen, get_dir_tree replay).
						const resultText = typeof p.content === 'string' ? p.content : flattenTextContent(p.content);
						if (toolNameLookup.has(p.tool_use_id)) {
							out.push({
								role: 'tool',
								content: [{
									type: 'tool-result',
									toolCallId: p.tool_use_id,
									toolName: toolNameLookup.get(p.tool_use_id)!,
									output: { type: 'text', value: resultText || EMPTY_CONTENT_PLACEHOLDER },
								}],
							});
						} else {
							// Orphan tool_result (its tool_use turn was summarized away): a bare
							// role:'tool' would 400 on strict providers — degrade to inline text.
							parts.push({ type: 'text', text: `[tool result]\n${resultText || EMPTY_CONTENT_PLACEHOLDER}` });
						}
					}
				}
				// A user message that consisted ONLY of tool_result blocks is fully represented
				// by the role:'tool' messages pushed above — don't emit an empty user turn.
				if (parts.length > 0) {
					out.push({ role: 'user', content: parts });
				} else if (out.length === 0 || out[out.length - 1].role !== 'tool') {
					out.push({ role: 'user', content: EMPTY_CONTENT_PLACEHOLDER });
				}
			} else {
				out.push({ role: 'user', content: EMPTY_CONTENT_PLACEHOLDER });
			}
			continue;
		}

		if (role === 'assistant') {
			const parts: AssistantContentPart[] = [];
			const content = msg.content;
			// AI SDK 4.x supports `{ type: 'reasoning', text }` parts inside assistant
			// messages. Providers that natively understand thinking-mode roundtrip
			// (DeepSeek via openai-compatible, openCodeGo/zen-proxied reasoning models)
			// require the previous assistant's `reasoning_content` to be sent back —
			// without it the provider rejects continuation with HTTP 400 "must be
			// passed back". Surface it FIRST (before text/tool-call parts) so the SDK
			// emits it in the right slot.
			const reasoningPayload: string | undefined = msg.reasoning_content || msg.reasoning;
			let reasoningText = '';
			if (typeof reasoningPayload === 'string' && reasoningPayload.length > 0) {
				parts.push({ type: 'reasoning', text: reasoningPayload });
				reasoningText = reasoningPayload;
			} else if (forceEmptyReasoningSlot) {
				// DeepSeek family hard requirement: every assistant turn must carry a
				// reasoning slot, even empty. Without it the provider returns HTTP 400
				// or — worse — closes the stream with an empty body that surfaces here
				// as "Empty response (reason: unknown)". Mirrors opencode upstream
				// behavior at provider/transform.ts:286-301.
				parts.push({ type: 'reasoning', text: '' });
			}
			if (typeof content === 'string' && content.length > 0) {
				parts.push({ type: 'text', text: content });
			} else if (Array.isArray(content)) {
				for (const p of content) {
					if (p?.type === 'text' && typeof p?.text === 'string') {
						parts.push({ type: 'text', text: p.text });
					} else if (p?.type === 'tool_use' && typeof p?.id === 'string' && typeof p?.name === 'string') {
						// Anthropic shape: tool calls live as content blocks, not `tool_calls`.
						// Dropped before → the model's own prior calls vanished from history.
						parts.push({ type: 'tool-call', toolCallId: p.id, toolName: p.name, input: p.input ?? {}, ...googleThoughtSignatureOptions((p as { thoughtSignature?: unknown }).thoughtSignature) });
					} else if (anthropicWire && p?.type === 'thinking' && typeof p.signature === 'string') {
						parts.push({ type: 'reasoning', text: p.thinking ?? '', providerOptions: { anthropic: { signature: p.signature } } });
					} else if (anthropicWire && p?.type === 'redacted_thinking' && typeof p.data === 'string') {
						parts.push({ type: 'reasoning', text: '', providerOptions: { anthropic: { redactedData: p.data } } });
					}
				}
			}
			if (Array.isArray(msg.tool_calls)) {
				for (const tc of msg.tool_calls) {
					let input: unknown = {};
					try { input = JSON.parse(tc?.function?.arguments ?? '{}'); }
					catch { input = lenientJsonParseObject(tc?.function?.arguments) ?? {}; } // roadmap 1708: recover malformed JSON args instead of dropping them
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
				// Interleaved-reasoning families need the reasoning text mirrored to
				// `providerOptions.openaiCompatible.reasoning_content` at the message
				// level — the AI SDK serializer routes that into the top-level
				// per-message JSON field these providers actually consume. Always
				// emit the field for the right family (even empty string) — DeepSeek
				// rejects continuations where the key is absent entirely.
				if (needsInterleavedMirror) {
					out.push({
						role: 'assistant',
						content: parts,
						providerOptions: {
							openaiCompatible: { reasoning_content: reasoningText },
						},
					});
				} else {
					out.push({ role: 'assistant', content: parts });
				}
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
			//     thinking via openCodeGo) require `reasoning_content` on the assistant
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
			for (const m of messages as ChatMessageView[]) {
				if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
					if (m.tool_calls.some(tc => tc?.id === callId)) {
						hasMatchingInSource = true;
						break;
					}
				}
			}

			let hasMatchingInOut = false;
			for (let j = out.length - 1; j >= 0; j--) {
				const m = out[j];
				if (m.role === 'assistant' && Array.isArray(m.content)) {
					if (m.content.some(p => p.type === 'tool-call' && p.toolCallId === callId)) {
						hasMatchingInOut = true;
					}
					break;
				}
				if (m.role === 'user') { break; }
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
				const orphanReasoningText = '(reasoning omitted during conversation summarization)';
				const orphanAssistant: ModelMessageOfRole<'assistant'> = {
					role: 'assistant',
					content: [
						// Non-empty placeholder satisfies DeepSeek's "reasoning_content must
						// be passed back" check. Content is intentionally short and explicit.
						{ type: 'reasoning', text: orphanReasoningText },
						{ type: 'tool-call', toolCallId: callId, toolName, input: {} },
					],
				};
				if (needsInterleavedMirror) {
					// Mirror reasoning to top-level message field for interleaved families
					// — same rationale as the regular assistant branch above.
					orphanAssistant.providerOptions = {
						openaiCompatible: { reasoning_content: orphanReasoningText },
					};
				}
				out.push(orphanAssistant);
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

/**
 * Repair native-FC tool-call ARG NAMES via the shared param-alias map.
 *
 * The AI SDK validates native function-call args against our registered
 * jsonSchema BEFORE the dispatcher's `applyParamAliases` ever runs, so a model
 * that emits `{path: "x"}` for a tool whose param is `uri` fails schema
 * validation and lands in `experimental_repairToolCall`. We normalize the param
 * names here (path/filePath/file → uri, cmd → command, …) — the same recovery
 * the XML-fallback path already gets. `input` arrives as a JSON string.
 *
 * Returns `changed: false` when no alias matched (e.g. cross-tool arg confusion
 * where the args belong to a different tool entirely) — the caller then routes
 * to the `invalid` pseudo-tool so the model gets a clean error instead of a
 * silently-re-submitted call that fails identically.
 */
function repairToolArgsViaAliases(canonicalToolName: string, rawInput: unknown): { input: unknown; changed: boolean } {
	if (typeof rawInput !== 'string') { return { input: rawInput, changed: false }; }
	let parsed: unknown;
	let usedLenient = false;
	try { parsed = JSON.parse(rawInput); }
	catch {
		// roadmap 1708: try to recover malformed JSON before giving up.
		parsed = lenientJsonParseObject(rawInput);
		if (parsed === undefined) { return { input: rawInput, changed: false }; }
		usedLenient = true;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return { input: rawInput, changed: false }; }
	const aliased = applyParamAliases(canonicalToolName, parsed as { [k: string]: unknown });
	// Detect a real rename by comparing key sets (ignores value/order noise).
	const before = Object.keys(parsed as object).sort().join(',');
	const after = Object.keys(aliased).sort().join(',');
	// When we had to repair malformed JSON, return the re-serialized valid form even
	// if no key was aliased — otherwise the caller would re-use the broken original.
	if (before === after && !usedLenient) { return { input: rawInput, changed: false }; }
	return { input: JSON.stringify(aliased), changed: true };
}

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
			if (!name) { continue; }
			const properties: Record<string, { description: string; type: 'string' }> = {};
			const required: string[] = [];
			for (const k of Object.keys(t.params)) {
				const desc = t.params[k].description;
				properties[k] = { description: desc, type: 'string' };
				if (!desc.trimStart().toLowerCase().startsWith('optional')) {
					required.push(k);
				}
			}
			const inputSchema: JSONSchema7 = {
				type: 'object',
				properties,
				...(required.length > 0 ? { required } : {}),
			};
			out[name] = tool({
				description: t.description,
				inputSchema: jsonSchema(inputSchema),
			});
		}
	}
	if (includeInvalidTool) {
		const invalidToolSchema: JSONSchema7 = {
			type: 'object',
			properties: {
				tool: { type: 'string', description: 'Original tool name the model attempted.' },
				error: { type: 'string', description: 'Why the call was considered invalid.' },
			},
		};
		out[INVALID_TOOL_NAME] = tool({
			description: 'Do not use. Reserved for repair routing.',
			inputSchema: jsonSchema(invalidToolSchema),
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
		settingsOfProvider: settingsFromWindow,
		modelName: modelName_,
		_setAborter,
		providerName,
		chatMode,
		overridesOfModel,
		modelSelectionOptions,
		mcpTools,
		runtimeOptions,
		separateSystemMessage,
	} = params;

	// A key that lives only in an OS environment variable reaches the request here: the window knows the
	// variable exists, only this process can read its value (see withEnvApiKey).
	const settingsOfProvider = withProcessEnvApiKey(settingsFromWindow, providerName);

	const caps = getModelCapabilities(providerName, modelName_, overridesOfModel);
	const { modelName, additionalOpenAIPayload, reasoningCapabilities } = caps;

	// Reasoning-control payload (e.g. `reasoning_effort`, `thinking:{type:disabled}`). Without this the
	// reasoning slider / off-toggle were dead: the user's choice never reached the request body. Merged
	// into `transformRequestBody` (openai-compatible only) alongside `additionalOpenAIPayload`; the other
	// wires carry the same choice as provider options, see `providerOptions` below.
	const { providerReasoningIOSettings, wireProtocolOfModel } = getProviderCapabilities(providerName);
	const reasoningInfo = getSendableReasoningInfo('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel);
	// «Off» is a choice of its own, not the absence of one: a model with a switch gets the value that turns
	// it off, where the model or its file names one; without that the vendor default would decide.
	const reasoningOff = !!reasoningCapabilities && reasoningCapabilities.canTurnOffReasoning
		&& !getIsReasoningEnabledState('Chat', providerName, modelName_, modelSelectionOptions, overridesOfModel);
	// The model's own «off» wins over the provider's: whoever wrote the entry knows that route's spelling.
	const reasoningInputPayload = {
		...(providerReasoningIOSettings?.input?.includeInPayload?.(reasoningInfo) ?? {}),
		...(reasoningOff && reasoningCapabilities ? reasoningCapabilities.reasoningOffPayload ?? providerReasoningIOSettings?.input?.offPayload ?? {} : {}),
	};
	// The per-request `extraBody` goes last: it is a contract for this one call (a JSON Schema for an
	// extraction), and a provider-wide default must not overwrite it.
	// The conversation's cache key goes only where the provider file declared it: a strict OpenAI-compatible
	// vendor answers 400 to a field it does not know (see common/promptCacheKey.ts).
	const promptCacheKey = (settingsOfProvider[providerName] as { promptCacheKey?: boolean } | undefined)?.promptCacheKey === true
		? runtimeOptions?.promptCacheKey
		: undefined;
	const openAICompatExtraBody: Record<string, unknown> = {
		...(additionalOpenAIPayload as Record<string, unknown> | undefined ?? {}),
		...reasoningInputPayload,
		...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
		...(runtimeOptions?.extraBody ?? {}),
	};

	// Honor `vibeide.llm.toolFallbackMode` (with backward-compat from legacy
	// `vibeide.llm.assumeNativeTools`) for aggregator-synthesized fallbacks.
	// Scope is intentionally narrow: known models (Claude, GPT, etc.) keep their
	// catalog-defined specialToolFormat regardless. See roadmap O.8.
	//
	// Priority for the final `specialToolFormat`:
	//   1. Model-quirks `forceToolCallFormat` ("native" / "xml") — explicit per-model
	//      override from `resources/model-quirks.json` or user `vibeide.modelQuirks`.
	//      Wins because the quirks catalog is the curated source of truth for
	//      known-broken combinations (e.g. qwen-* needs XML on naked-tag grammar).
	//   2. User runtime `toolFallbackMode` ("native" / "xml") — global per-session knob.
	//   3. Catalog `specialToolFormat` from getModelCapabilities + auto-downgrade.
	const quirks = getModelQuirks(modelName, providerName);
	const isAggregatorSynthesized = caps.recognizedModelName === '__aggregator_unknown__';
	const toolFallbackMode = runtimeOptions?.toolFallbackMode ?? 'auto';
	const specialToolFormat = (() => {
		// Tier 1: model-quirks override. Applies regardless of aggregator-synth status —
		// these overrides are explicitly curated for the model.
		if (quirks.forceToolCallFormat === 'native') { return 'openai-style' as const; }
		if (quirks.forceToolCallFormat === 'xml') { return undefined; }
		// Tier 2 (existing): only for aggregator-synthesized fallbacks.
		if (!isAggregatorSynthesized) { return caps.specialToolFormat; }
		if (toolFallbackMode === 'native') { return 'openai-style' as const; }
		if (toolFallbackMode === 'xml') { return undefined; }
		if (runtimeOptions?.assumeNativeTools === false) { return undefined; }
		return caps.specialToolFormat;
	})();

	// Open-source think-tag reasoning: wrap callbacks to extract <think>...</think>.
	const openSourceThinkTags = reasoningCapabilities ? reasoningCapabilities.openSourceThinkTags : undefined;
	let onText = onText_;
	let onFinalMessage = onFinalMessage_;
	// Universal safety net, applied INNERMOST (runs last, on the final text handed to the consumer):
	// strip orphan reasoning-delimiter lines (a lone </think> with no <think>) that native-reasoning
	// models leak into content via aggregators. Cleans both the displayed answer and the saved turn
	// (so the stray tag isn't replayed to the model next request). Other wrappers see the raw text.
	{
		const wrapped = stripStandaloneThinkDelimitersWrapper(onText, onFinalMessage);
		onText = wrapped.newOnText;
		onFinalMessage = wrapped.newOnFinalMessage;
	}
	if (openSourceThinkTags) {
		const wrapped = extractReasoningWrapper(onText, onFinalMessage, openSourceThinkTags);
		onText = wrapped.newOnText;
		onFinalMessage = wrapped.newOnFinalMessage;
	}
	// Native-reasoning models that ALSO duplicate the CoT as inline <think> in content
	// (MiniMax-M3): strip the duplicate from the body WITHOUT touching the native reasoning
	// channel (it stays authoritative for the fold + export). See stripThinkTagsWrapper.
	const stripThinkTags = reasoningCapabilities ? reasoningCapabilities.stripThinkTagsFromContent : undefined;
	if (stripThinkTags) {
		const wrapped = stripThinkTagsWrapper(onText, onFinalMessage, stripThinkTags);
		onText = wrapped.newOnText;
		onFinalMessage = wrapped.newOnFinalMessage;
	}
	// XML tool fallback when native tools are disabled for this model.
	if (!specialToolFormat) {
		const wrapped = extractXMLToolsWrapper(onText, onFinalMessage, chatMode, mcpTools, { providerName, modelName });
		onText = wrapped.newOnText;
		onFinalMessage = wrapped.newOnFinalMessage;
	}

	let resolved: ResolvedEndpoint;
	try {
		resolved = await resolveEndpoint(providerName as AiSdkProviderName, modelName, settingsOfProvider);
	} catch (e) {
		onError({ message: e instanceof Error ? e.message : String(e), fullError: e instanceof Error ? e : null });
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
	//   2. `protocol` declared by the CONFIG provider's file entry
	//      (providers.json → transport overlay) — the author's per-provider
	//      declaration; without this a catalog-unknown model on an
	//      anthropic/gemini endpoint silently fell to the openai-compat wire
	//      format and broke.
	//   3. models.dev catalog (data-driven) — returns the `npm` field
	//      (`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`, etc.) for the
	//      (baseURL, modelName) tuple.
	//   4. Fallback: openai-compatible (safe default; even if wrong, the
	//      auto-downgrade pipeline catches resulting tool-call quirks).
	const apiProtocolOverride = (overridesOfModel?.[providerName as Exclude<typeof providerName, 'auto'>]?.[modelName_] as { apiProtocol?: ApiProtocolOverride } | undefined)?.apiProtocol;
	// Map override → SDK npm via the shared const in modelCapabilities (single
	// source of truth — adding a new protocol there propagates here automatically).
	const sdkNpmFromOverride: string | undefined = apiProtocolOverride
		? API_PROTOCOL_TO_SDK_NPM[apiProtocolOverride]
		: undefined;
	// A model's own `protocol` beats the provider's: one aggregator key can serve several wire
	// formats and pick by model (OpenCode Go — chat-completions, messages and responses on the same
	// baseURL), so a per-provider value describes at best part of such a catalogue.
	const fileSettings = settingsOfProvider[providerName] as { protocol?: string; modelProtocols?: Record<string, string> } | undefined;
	// Looked up under both names: `modelName` is what goes on the wire after capability resolution,
	// `modelName_` is what the user picked. They differ when a model is selected through an alias,
	// and the file's key can honestly be either.
	const fileProtocol = fileSettings?.modelProtocols?.[modelName.toLowerCase()]
		?? fileSettings?.modelProtocols?.[modelName_.toLowerCase()]
		?? fileSettings?.protocol;
	const sdkNpmFromFile = sdkNpmOfFileProtocol(fileProtocol);
	// A built-in with a wire of its own is not guessed by the catalogue (see builtinWireSdkNpm); the
	// catalogue still says which OpenAI models need Responses.
	const sdkNpmOfBuiltin = builtinWireSdkNpm(providerName, fileProtocol, wireProtocolOfModel?.(caps.recognizedModelName ?? modelName));
	const sdkNpm = sdkNpmFromOverride ?? sdkNpmOfBuiltin ?? sdkNpmFromFile ?? await getModelSdkNpm(baseURL, modelName);
	// Diagnostic: log which SDK path was taken on the FIRST request per
	// (provider × model × source). Cache key prevents per-request spam in
	// long sessions. Downgraded to console.debug (hidden by default in
	// devtools) — the routing decision was once-suspect, now stable.
	// Bypass the dedup if it actually changes for the same combo (rare, but
	// e.g. catalog refresh mid-session could switch sdkNpm).
	const sdkSource = sdkNpmFromOverride ? 'override' : sdkNpmOfBuiltin ? 'builtin' : sdkNpmFromFile ? 'file' : (sdkNpm ? 'models.dev' : 'fallback');
	const anthropicWire = sdkNpm === '@ai-sdk/anthropic';
	const openAIWire = sdkNpm === '@ai-sdk/openai' || sdkNpm === '@ai-sdk/openai#responses';
	const googleWire = sdkNpm === '@ai-sdk/google';
	// Latest quota the provider reported during THIS call; attached to the final message so the
	// renderer can show the key's real remaining allowance next to our own token estimate.
	let lastQuota: ProviderQuotaSnapshot | undefined;
	let lastAnsweredModel: string | undefined;
	let lastSystemFingerprint: string | undefined;
	// Kept for the failure paths: without it an "empty response" cannot be told apart from a
	// refusal the provider hid in the body of an HTTP 200 (modelStalls.md #001).
	let lastDiagnostics: ProviderRefusalDiagnostics | undefined;
	// The key of a provider from a file goes where the file and THIS request's wire say — the wire is known only here
	const fileKey = resolved.fileKey;
	const fileKeyPlacement = fileKey ? keyPlacement(fileKey.auth, fileKey.key, wireOfSdkNpm(sdkNpm)) : undefined;
	if (fileKeyPlacement) {
		try {
			for (const name of Object.keys(fileKeyPlacement.headers)) {
				assertHttpHeaderSafe(`Dynamic provider "${providerName}" key header name "${name}"`, name);
			}
		} catch (e) {
			onError({ message: e instanceof Error ? e.message : String(e), fullError: e instanceof Error ? e : null });
			return;
		}
	}
	// A file model on the Anthropic wire: its `extraBody` and its own «off» (MiMo: `thinking: {type: "disabled"}`) are a
	// contract with that route, and @ai-sdk/anthropic takes no body transform — they go in through the fetch door.
	// Built-ins are left alone: their caps were written for the OpenAI-compatible body.
	const anthropicBodyPatch = anthropicWire && !isBuiltinProvider(providerName) ? {
		...(additionalOpenAIPayload as Record<string, unknown> | undefined ?? {}),
		...(reasoningOff && reasoningCapabilities?.reasoningOffPayload ? reasoningCapabilities.reasoningOffPayload : {}),
	} : undefined;
	const callFetch = makeCustomFetch({
		providerName,
		...(fileKey && fileKeyPlacement ? { fileKey: { headers: fileKeyPlacement.headers, query: { ...fileKey.query, ...fileKeyPlacement.query } } } : {}),
		...(anthropicBodyPatch && Object.keys(anthropicBodyPatch).length > 0 ? { bodyPatch: anthropicBodyPatch } : {}),
		onQuota: snapshot => { lastQuota = snapshot; },
		onAnsweredModel: (model, fingerprint) => { lastAnsweredModel = model; lastSystemFingerprint = fingerprint; },
		onOrchestrationTokens: tokens => { lastOrchestrationTokens = tokens; },
		onDiagnostics: diagnostics => { lastDiagnostics = diagnostics; },
	});

	const sdkLogKey = `${providerName}|${modelName}|${sdkNpm ?? 'fallback'}|${sdkSource}`;
	if (!_loggedSdkSelections.has(sdkLogKey)) {
		_loggedSdkSelections.add(sdkLogKey);
		vibeLog.debug('aiSdkAdapter', `[aiSdkAdapter] provider=${providerName} model=${modelName} baseURL=${baseURL} sdkNpm=${sdkNpm ?? '(unknown → fallback openai-compatible)'} source=${sdkSource}`);
	}
	const languageModel: LanguageModel = sdkNpm === '@ai-sdk/anthropic'
		? createAnthropic({
			baseURL,
			apiKey,
			// Anthropic's own API gets no legacy beta flags: the SDK streams tool input eagerly on its own
			// (`eager_input_streaming`), adaptive thinking interleaves without a header, and the vendor asks
			// not to send the old tool-streaming flag next to the new field. Compatible upstreams keep them.
			headers: providerName === 'anthropic' ? headers : {
				...headers,
				// Anthropic-beta flags mirrored from opencode CLI (anomalyco/opencode
				// provider/provider.ts:155-165 "anthropic" custom config). Without
				// `fine-grained-tool-streaming-2025-05-14` the tool_use stream comes
				// through in a coarser format that minimax-style models render as
				// degenerate output (numeric tool names, empty params). The
				// `interleaved-thinking` flag is for reasoning models.
				'anthropic-beta': 'interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
			},
			fetch: callFetch,
		})(modelName)
		: sdkNpm === '@ai-sdk/openai#responses'
			? // OpenAI Responses API — a DIFFERENT endpoint (`/v1/responses`), not a dialect of
			// chat-completions. Reached only when asked for explicitly, because a model served
			// there answers 404 on chat-completions and vice versa. OpenCode Go serves Grok 4.6,
			// GPT 5.6 Luna and Muse Spark only here.
			createOpenAI({
				baseURL,
				apiKey,
				headers,
				fetch: callFetch,
			}).responses(modelName)
			: sdkNpm === '@ai-sdk/openai'
				? // Native OpenAI SDK. Default `.chat()` shape — chat-completions endpoint.
				// Functionally equivalent to openai-compatible for our use-case, but uses the
				// native serializer which preserves OpenAI-specific fields (logprobs,
				// parallel_tool_calls, etc.) without the openai-compatible "unknown field"
				// stripping.
				createOpenAI({
					baseURL,
					apiKey,
					headers,
					fetch: callFetch,
				}).chat(modelName)
			: sdkNpm === '@ai-sdk/google'
				? // Native Google Generative AI (Gemini): the built-in `gemini` provider, a
				// Gemini model the models.dev catalog maps here (openCodeGo/zen, openRouter
				// with Gemini), or the user's apiProtocol="google" override. Tool-call format is
				// functionDeclarations / functionCall — different from OpenAI shape
				// — but @ai-sdk/google handles that conversion internally.
				createGoogleGenerativeAI({
					baseURL,
					apiKey,
					headers,
					fetch: callFetch,
				})(modelName)
				: createOpenAICompatible({
					name: providerName,
					baseURL,
					apiKey,
					headers,
					queryParams,
					fetch: callFetch,
					includeUsage: true,
					metadataExtractor: cacheWriteTokensExtractor,
					transformRequestBody: Object.keys(openAICompatExtraBody).length
						? (body) => ({ ...body, ...openAICompatExtraBody })
						: undefined,
				}).chatModel(modelName);

	// A compatible upstream can reject a block type it does not know with the whole request; the quirk
	// narrows what goes there and names what was dropped (common/anthropicStrictBlocks.ts).
	let messagesForWire = messages;
	if (anthropicWire && quirks.anthropicStrictBlocks === true) {
		const strict = stripUnknownContentBlocks(messages as unknown as Array<{ content?: unknown }>);
		if (strict.dropped.length > 0) {
			vibeLog.warn('aiSdkAdapter', `anthropicStrictBlocks: отброшены типы блоков ${strict.dropped.join(', ')} для ${providerName}/${modelName}`);
		}
		messagesForWire = strict.messages as unknown as LLMChatMessage[];
	}
	let modelMessages = convertMessagesToModelMessages(messagesForWire, modelName, providerName, anthropicWire);
	// Prompt caching for the Anthropic protocol (knowledge/roadmap/tokenEconomy.md, A phase 2).
	// Anthropic caches NOTHING without explicit `cache_control` breakpoints — every agentic
	// turn re-bills the full prompt (observed: 23k input/turn → org TPM limit in 11 turns).
	// Two of the four allowed breakpoints:
	//   1. the system prompt (biggest stable block) — moved INTO messages as a system role,
	//      because the top-level `system: string` option cannot carry providerOptions;
	//   2. the LAST message — Anthropic reuses the longest previously-cached prefix, so
	//      marking the tail makes each turn cache the whole conversation for the next one.
	// Harmless when a proxy (openCodeGo Zen) strips the field — it is purely additive.
	// Reasoning effort as PROSE for models that never learned the API field (quirk
	// `reasoningEffortInSystemPrompt`, e.g. Muse Glimmer). Applied before the caching
	// branches below, so the line is inside the block that gets the cache breakpoint —
	// it is stable across turns and must not split the cached prefix.
	let systemForCall: string | undefined = withReasoningEffortInSystemPrompt(
		systemPromptOf(separateSystemMessage, messagesForWire),
		quirks.reasoningEffortInSystemPrompt,
		reasoningInfo?.type === 'effort_slider_value' ? reasoningInfo.reasoningEffort : undefined,
	);
	if (sdkNpm === '@ai-sdk/anthropic') {
		// A declared hour of cache life (`cacheTtl: "1h"`) costs more to write and saves a full re-read
		// after a pause longer than the vendor's five minutes; absent — the vendor default.
		const cacheCtl: MessageProviderOptions = { anthropic: { cacheControl: { type: 'ephemeral', ...(caps.promptCacheTtl ? { ttl: caps.promptCacheTtl } : {}) } } };
		if (systemForCall) {
			const systemMsg: ModelMessageOfRole<'system'> = { role: 'system', content: systemForCall, providerOptions: cacheCtl };
			modelMessages = [systemMsg, ...modelMessages];
			systemForCall = undefined;
		}
		const lastMsg = modelMessages[modelMessages.length - 1];
		if (lastMsg) { lastMsg.providerOptions = { ...(lastMsg.providerOptions ?? {}), ...cacheCtl }; }
	} else if (providerName === 'openRouter' && /claude/i.test(modelName)) {
		// OpenRouter (OpenAI-shape API) forwards Anthropic `cache_control` markers for
		// claude-family models. The openai-compatible serializer spreads
		// `providerOptions.openaiCompatible` into the serialized message AND into each
		// content part (verified in @ai-sdk/openai-compatible convertToOpenAICompatible-
		// ChatMessages), so the marker lands as a raw `cache_control` field. Same two
		// breakpoints as the native route: system + the last message. EXPERIMENT status:
		// whether OpenRouter honors message-level (vs part-level) placement is confirmed
		// by the `cached:` numbers in the TokenBudget log — harmless if ignored.
		const orCacheCtl: MessageProviderOptions = { openaiCompatible: { cache_control: { type: 'ephemeral' } } };
		if (systemForCall) {
			const systemMsg: ModelMessageOfRole<'system'> = { role: 'system', content: systemForCall, providerOptions: orCacheCtl };
			modelMessages = [systemMsg, ...modelMessages];
			systemForCall = undefined;
		}
		const lastMsg = modelMessages[modelMessages.length - 1];
		if (lastMsg) {
			if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
				// Part-level marker (documented OpenRouter shape) when the message has parts.
				// All real content parts carry an optional `providerOptions`; narrow to that
				// carrier shape since the broad union also nominally includes approval parts.
				const lastPart = lastMsg.content[lastMsg.content.length - 1] as { providerOptions?: MessageProviderOptions };
				lastPart.providerOptions = { ...(lastPart.providerOptions ?? {}), ...orCacheCtl };
			} else {
				lastMsg.providerOptions = { ...(lastMsg.providerOptions ?? {}), ...orCacheCtl };
			}
		}
	}
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
		// `caps.maxTools` is the per-model tool budget from `.vibe/providers.json`. Undefined means
		// no limit — a model without a declared budget must get exactly the list it got before.
		? convertToolsToAiSdkToolSet(availableTools(chatMode, mcpTools, { maxTools: caps.maxTools }), true)
		: undefined;
	const activeTools = tools
		? Object.keys(tools).filter(k => k !== INVALID_TOOL_NAME)
		: undefined;

	// How long the model may stay silent before its first visible token — the phase the idle timer below
	// does not cover (a reasoning model thinking). Not a cap on the answer: once content flows, only a
	// stall ends the stream. Local servers answer fast or not at all; aggregators add a hop.
	// The file's own `timeoutMs` is the author's word for this server and beats the defaults by kind
	const firstContentLimitMs = resolved.timeoutMs ?? (isLocalProvider(providerName, settingsOfProvider)
		? runtimeOptions?.timeoutMs?.local ?? 30_000
		: AGGREGATOR_PROVIDERS.has(providerName) || !isBuiltinProvider(providerName)
			? runtimeOptions?.timeoutMs?.aggregator ?? 180_000
			: runtimeOptions?.timeoutMs?.cloud ?? 180_000);

	const abortController = new AbortController();
	let timeoutFired = false;
	let timeoutDeliveredPartial = false;
	_setAborter(() => abortController.abort());

	// Accumulators
	let fullTextSoFar = '';
	let fullReasoningSoFar = '';
	let toolName = '';
	let toolId = '';
	let toolSignature: string | undefined;
	let toolParamsStr = '';
	// Set by the SDK's `tool-call` part: the arguments are whole. Until then they are a prefix of JSON,
	// and a call cut there must never run — half of a file write is worse than no write.
	let toolCallComplete = false;
	// Claude's signed thinking, kept whole for the next turn (Anthropic wire only; empty elsewhere).
	const reasoningCollector = new AnthropicReasoningCollector();
	let firstTokenReceived = false;
	let contentStarted = false;
	let firstTokenTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let firstContentTimeoutId: ReturnType<typeof setTimeout> | null = null;
	// Idle (inter-token) timeout: abort if the stream goes silent for `idleMs`
	// after content has started. A model that STALLS mid-stream (e.g. native FC on
	// an openCodeGo aggregator that confuses tool args) is caught in ~45s, while a
	// legitimately long response keeps emitting tokens and is never cut: there is
	// no wall-clock cap once content flows. (There used to be one — 180s from the
	// start — which cut long answers and, worse, handed their half-written tool
	// call on as finished.)
	let idleTimeoutId: ReturnType<typeof setTimeout> | null = null;
	const idleMs = runtimeOptions?.timeoutMs?.streamIdle ?? 45_000;
	// Connection liveness ceiling — see the firstTokenTimeoutId arm below. Config-driven default.
	const connectionMs = runtimeOptions?.timeoutMs?.connection ?? 90_000;
	let lastFinishReason: string | null = null;
	// The vendor's own word for why it stopped (`max_tokens`, `refusal`, `model_context_window_exceeded`),
	// and what came with it (Anthropic's refusal category). The unified reason above loses both.
	let lastRawFinishReason: string | undefined;
	let lastFinishMetadata: unknown;
	// Last `usage` block emitted by the AI SDK on `finish-step` / `finish` parts.
	// We surface this in onFinalMessage so the UI can display real prompt/completion
	// token counts from the provider instead of relying on length/4 heuristics.
	let lastUsage: LLMTokenUsage | undefined;
	// Set by the response tail observer; added to the SDK's usage when the answer is final.
	let lastOrchestrationTokens: OrchestrationTokens | undefined;

	const clearAllTimers = () => {
		if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); firstTokenTimeoutId = null; }
		if (firstContentTimeoutId) { clearTimeout(firstContentTimeoutId); firstContentTimeoutId = null; }
		if (idleTimeoutId) { clearTimeout(idleTimeoutId); idleTimeoutId = null; }
	};

	// Connection liveness: cleared by the FIRST stream part of ANY kind (a `start`
	// part, reasoning, text, tool-input — anything means the upstream answered and
	// is alive). The connection timeout below only fires if NOTHING arrives. We do
	// NOT abort a connected-but-silent stream (a model thinking before it emits) —
	// that's what falsely killed deepseek/minimax mid-reasoning and triggered the
	// abort→retry churn. The first-content limit + the idle timer cover real hangs.
	const markConnected = () => {
		if (firstTokenReceived) { return; }
		firstTokenReceived = true;
		if (firstTokenTimeoutId) { clearTimeout(firstTokenTimeoutId); firstTokenTimeoutId = null; }
	};

	const buildPartialToolCallObj = (): RawToolCallObj | undefined => {
		if (!toolName) { return undefined; }
		const rawParams: RawToolParamsObj = {};
		return { name: toolName, rawParams, doneParams: [], id: toolId, isDone: false };
	};

	const finalizeToolCall = (): RawToolCallObj | null => {
		if (!toolName) { return null; }
		let input: unknown;
		try { input = JSON.parse(toolParamsStr || '{}'); }
		catch { input = lenientJsonParseObject(toolParamsStr); } // roadmap 1708: recover malformed JSON args instead of dropping the whole call
		if (input === null || typeof input !== 'object') { return null; }
		const rawParams = input as RawToolParamsObj;
		return {
			id: toolId || generateUuid(),
			name: toolName,
			rawParams,
			doneParams: Object.keys(rawParams),
			isDone: true,
		};
	};

	// Connection (NOT first-CONTENT) timeout: fires only if the stream produces no
	// part AT ALL — a dead / never-answered request. `markConnected` (stream-loop
	// top) clears it on the first part of ANY kind, so a connected-but-still-thinking
	// model (reasoning silently before it emits) is NOT aborted — that false abort
	// was the abort→retry churn. 90s is a deliberately generous TEMPORARY ceiling
	// until the [VibeIDE/llmTurn] trace shows how openCodeGo actually streams (early
	// `start` part vs buffering ~60s); then we tune the number from data, not guesses.
	firstTokenTimeoutId = setTimeout(() => {
		if (!firstTokenReceived) { abortController.abort(new Error('Connection timeout (no stream parts received).')); }
	}, connectionMs);

	// Shared hard-timeout handler for BOTH the first-content limit and the idle
	// timer. Delivers the text and reasoning that did arrive, or an error, then
	// aborts. A tool call is delivered only if its arguments are whole: a stall
	// in the middle of them leaves a JSON prefix, and running that would execute
	// a different call than the model meant. Guarded so it runs at most once.
	const handleHardTimeout = (errMessage: string) => {
		if (timeoutFired) { return; }
		timeoutFired = true;
		const cutToolCall = !!toolName && !toolCallComplete;
		if (fullTextSoFar || fullReasoningSoFar || (toolName && toolCallComplete)) {
			timeoutDeliveredPartial = true;
			const tc = toolCallComplete ? finalizeToolCall() : null;
			onFinalMessage({
				fullText: fullTextSoFar,
				fullReasoning: fullReasoningSoFar,
				anthropicReasoning: reasoningCollector.blocks(),
				...(tc ? { toolCall: toolSignature ? { ...tc, thoughtSignature: toolSignature } : tc } : {}),
				...usageField(withOrchestration(lastUsage, lastOrchestrationTokens)),
				...(lastQuota ? { providerQuota: lastQuota } : {}),
				...(lastAnsweredModel ? { answeredModel: lastAnsweredModel } : {}),
				...(lastSystemFingerprint ? { systemFingerprint: lastSystemFingerprint } : {}),
				...(cutToolCall ? { finishNotice: { kind: 'stalled', cutToolName: toolName } satisfies LLMFinishNotice } : {}),
			});
		} else {
			onError({ message: cutToolCall ? cutToolCallMessage(toolName, errMessage) : errMessage, fullError: null });
		}
		abortController.abort();
	};

	firstContentTimeoutId = setTimeout(() => handleHardTimeout(`Модель молчит дольше ${Math.round(firstContentLimitMs / 1000)}с — ответ так и не начался.`), firstContentLimitMs);

	// (Re)arm the idle timer — armed on the first CONTENT part and reset on each
	// subsequent content part. Governs ONLY the post-content phase (inter-token
	// gaps); the silent pre-content reasoning warmup is intentionally NOT covered
	// (it's a thinking model, not a stall) — the first-content limit bounds that.
	const resetIdle = () => {
		if (timeoutFired) { return; }
		if (idleTimeoutId) { clearTimeout(idleTimeoutId); }
		idleTimeoutId = setTimeout(() => handleHardTimeout(`Стрим завис — нет токенов ${idleMs / 1000}с после начала ответа.`), idleMs);
	};
	// The end of an answer, streamed or not: an error when nothing usable arrived, the answer otherwise —
	// with a notice when it stopped for a reason the reader must know (llmStreamFinish.ts).
	const deliverAnswer = () => {
		const notice = finishNoticeOf(lastFinishReason, lastRawFinishReason, lastFinishMetadata);
		// Attach whatever the provider actually said. An empty stream is the ONE path where
		// there is no Error object to carry status/headers/body, so without this the caller
		// cannot tell "the model stopped" from "the provider refused inside an HTTP 200".
		// Interpreting the verdict is deliberately left to `chatThreadService` — one place
		// owns error classification.
		const diagnostics = lastDiagnostics ? { diagnostics: lastDiagnostics } : {};
		if (!fullTextSoFar && !fullReasoningSoFar && !toolName) {
			if (notice?.kind === 'refusal') {
				onError({ message: refusalMessage(modelName, notice.category, notice.explanation), fullError: null, ...diagnostics });
				return;
			}
			// Context-overflow signals can surface in the vendor's own reason (z.ai emits
			// `model_context_window_exceeded`) or stay invisible on the stream-empty path.
			// Detect the former so the UI gets a targeted "compact history" hint instead of
			// a generic "unknown" toast.
			const reason = lastRawFinishReason ?? lastFinishReason ?? 'unknown';
			if (isContextOverflow(reason)) {
				onError({
					message: buildContextOverflowError(providerName, modelName, `finishReason: ${reason}`),
					fullError: null,
					...diagnostics,
				});
			} else {
				onError({
					message: buildEmptyResponseError(providerName, modelName, reason),
					fullError: null,
					...diagnostics,
				});
			}
			return;
		}
		// A call without its `tool-call` part stopped mid-arguments — a stream that ended early. So does any
		// call of an answer cut by the output limit: the SDK still emits `tool-call` for the unfinished block,
		// and the repair hook would «recover» the JSON prefix into arguments the model never wrote. Running
		// either would execute a call the model did not finish.
		const cutToolCall = !!toolName && (!toolCallComplete || notice?.kind === 'truncated');
		if (cutToolCall && !fullTextSoFar && !fullReasoningSoFar) {
			const reason = notice?.kind === 'truncated' ? TRUNCATED_TOOL_CALL_REASON : 'Поток ответа закончился раньше, чем модель дописала вызов.';
			onError({ message: cutToolCallMessage(toolName, reason), fullError: null, ...diagnostics });
			return;
		}
		const finishNotice: LLMFinishNotice | undefined = cutToolCall
			? { kind: 'truncated', by: notice?.kind === 'truncated' ? notice.by : 'output-limit', cutToolName: toolName }
			: notice;
		const tc = cutToolCall ? null : finalizeToolCall();
		onFinalMessage({
			fullText: fullTextSoFar,
			fullReasoning: fullReasoningSoFar,
			anthropicReasoning: reasoningCollector.blocks(),
			...(tc ? { toolCall: toolSignature ? { ...tc, thoughtSignature: toolSignature } : tc } : {}),
			...usageField(withOrchestration(lastUsage, lastOrchestrationTokens)),
			...(lastQuota ? { providerQuota: lastQuota } : {}),
			...(lastAnsweredModel ? { answeredModel: lastAnsweredModel } : {}),
			...(lastSystemFingerprint ? { systemFingerprint: lastSystemFingerprint } : {}),
			...(finishNotice ? { finishNotice } : {}),
		});
	};

	// NOTE: NOT armed here — armed on first content delta (see stream loop). Arming
	// at stream start would re-introduce the false abort of a silent thinking phase.
	// Content has begun: the first-content limit has done its job, stalls are the idle timer's now.
	const markContent = () => {
		if (!contentStarted) {
			contentStarted = true;
			if (firstContentTimeoutId) { clearTimeout(firstContentTimeoutId); firstContentTimeoutId = null; }
		}
		resetIdle();
	};

	// The reasoning choice and the per-vendor extras, spelled for the wire this request takes. The
	// OpenAI-compatible wire got its share in the body above (`openAICompatExtraBody`).
	const providerOptions: Record<string, JSONObject> = {};
	if (anthropicWire && providerName === 'anthropic') {
		providerOptions.anthropic = claudeThinkingOptions(reasoningInfo, runtimeOptions?.claudeThinkingDisplay ?? DEFAULT_CLAUDE_THINKING_DISPLAY, quirks.reasoningBoundToModel === true);
	} else if (anthropicWire && reasoningCapabilities && reasoningCapabilities.supportsReasoning) {
		// Another route on the same wire (OpenCode Zen, a gateway, a provider from a file): thinking goes when the model
		// declares reasoning, in the spelling the MODEL takes — adaptive for Claude 5, a token budget for the rest
		const effortWords = reasoningCapabilities.reasoningSlider?.type === 'effort_slider' ? reasoningCapabilities.reasoningSlider.values : undefined;
		providerOptions.anthropic = compatibleClaudeThinkingOptions(reasoningInfo, runtimeOptions?.claudeThinkingDisplay ?? DEFAULT_CLAUDE_THINKING_DISPLAY, quirks.adaptiveThinking === true, effortWords);
	}
	if (openAIWire) {
		const reasoningEffort = openAIReasoningEffort(reasoningInfo, reasoningOff, reasoningCapabilities ? reasoningCapabilities.reasoningOffEffort : undefined);
		providerOptions.openai = {
			...(reasoningEffort ? { reasoningEffort } : {}),
			// The native SDK takes the cache key as a provider option; the compatible path gets
			// `prompt_cache_key` in the body above.
			...(promptCacheKey ? { promptCacheKey } : {}),
			// Responses keeps every response on OpenAI's servers for 30 days unless told otherwise; chat
			// completions, which OpenAI's own route used until now, never did. Nothing here reads a stored
			// response back, so nothing is stored.
			...(providerName === 'openAI' && sdkNpm === '@ai-sdk/openai#responses' ? { store: false } : {}),
		};
	}
	if (googleWire && providerName === 'gemini') {
		const thinkingConfig = googleThinkingConfig(reasoningInfo);
		if (thinkingConfig) {
			providerOptions.google = { thinkingConfig: { ...thinkingConfig } };
		}
	}
	// Anthropic requires `max_tokens`, and thinking spends it together with the answer: the catalogue's
	// reserved output for this model and reasoning state. Other wires keep the vendor default, as before.
	const maxOutputTokens = anthropicWire && providerName === 'anthropic'
		? getReservedOutputTokenSpace(providerName, modelName_, { isReasoningEnabled: !!reasoningInfo?.isReasoningEnabled, overridesOfModel }) ?? 4_096
		: undefined;
	const toolChoice = runtimeOptions?.forceToolUse && tools && !quirks.forcedToolChoiceUnsupported ? 'required' as const : (tools ? 'auto' as const : undefined);
	const hasProviderOptions = Object.values(providerOptions).some(options => Object.keys(options).length > 0);

	// Model-family generation params (kimi/minimax/glm/gemini/qwen/...). Catalog-driven
	// via getModelQuirks() — see resources/model-quirks.json. `ModelSelectionOptions`
	// does not currently surface temperature/topP/topK, so catalog values apply
	// unconditionally for matched models and are a no-op for everything else.
	// User can override per-model via `vibeide.modelQuirks` setting.
	// Order matters: the file's `default*` values come from `.vibe/providers.json` and act as
	// the model's vendor-recommended defaults; the quirks catalog then overrides per field,
	// because it is the curated fix-list for combinations known to misbehave. Previously the
	// file's fields were dropped entirely — declared in the type and the spec, never read.
	const modelParams: { temperature?: number; topP?: number; topK?: number } = {};
	if (caps.defaultTemperature !== undefined) { modelParams.temperature = caps.defaultTemperature; }
	if (caps.defaultTopP !== undefined) { modelParams.topP = caps.defaultTopP; }
	if (caps.defaultTopK !== undefined) { modelParams.topK = caps.defaultTopK; }
	if (quirks.temperature !== undefined) { modelParams.temperature = quirks.temperature; }
	if (quirks.topP !== undefined) { modelParams.topP = quirks.topP; }
	if (quirks.topK !== undefined) { modelParams.topK = quirks.topK; }

	// Five-stage repair for tool-call mismatches (name AND args):
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
	//   4. **Arg-name repair.** Once the NAME resolves, normalise PARAM
	//      names via the same alias map (path/filePath/file → uri, cmd →
	//      command). The SDK validates native-FC args against our schema
	//      BEFORE the dispatcher's applyParamAliases runs, so `{path:…}`
	//      for a `uri`-param tool fails here — recover it on the native
	//      channel too (XML fallback already gets this). See
	//      repairToolArgsViaAliases. Idea ported from crush/fantasy +
	//      opencode (arg-level recovery, not just names).
	//   5. Anything still unmatched routes to the `invalid` pseudo-tool.
	// Without stages 1-4 the SDK would throw NoSuchTool/InvalidToolArguments
	// for recoverable calls. Pattern from Kilo Code (extended 3 + 4).
	const repairToolCall: ToolCallRepairFunction<ToolSet> = async ({ toolCall, tools: registeredTools, error }) => {
		if (!registeredTools) { return null; }
		const has = (n: string) => Object.prototype.hasOwnProperty.call(registeredTools, n);
		const raw = toolCall.toolName ?? '';
		const lowered = raw.toLowerCase();

		// Stages 1-3: resolve the canonical tool NAME.
		let resolved: string | null = null;
		if (raw && has(raw)) {
			resolved = raw; // name already valid → the failure is the ARGS (stage 4)
		} else if (raw && lowered !== raw && has(lowered)) {
			resolved = lowered; // stage 1: lowercase
		} else if (TOOL_NAME_ALIASES[lowered] && has(TOOL_NAME_ALIASES[lowered])) {
			resolved = TOOL_NAME_ALIASES[lowered]; // stage 2: cross-ecosystem alias
		} else {
			const numericMatch = /^(\d+)$/.exec(raw); // stage 3: positional
			if (numericMatch) {
				const idx = parseInt(numericMatch[1], 10);
				const toolNames = Object.keys(registeredTools).filter(k => k !== INVALID_TOOL_NAME);
				if (idx >= 0 && idx < toolNames.length) { resolved = toolNames[idx]; }
			}
		}

		// Stage 4: with a resolved name, also repair ARG names. Return when
		// the name changed (a fix worth retrying) OR an arg-alias applied. If
		// the name was already valid and no alias helped (cross-tool arg
		// confusion / fundamentally wrong args), fall through to `invalid` so
		// the model gets a clean error rather than an identically-failing retry.
		if (resolved && resolved !== INVALID_TOOL_NAME) {
			const { input: repairedInput, changed } = repairToolArgsViaAliases(resolved, toolCall.input);
			if (resolved !== raw || changed) {
				// `repairToolArgsViaAliases` returns the original `input` string when no
				// change applied, or a re-serialized JSON string when it did — both are
				// strings here since `toolCall.input` is a string.
				const repairedInputStr = typeof repairedInput === 'string' ? repairedInput : toolCall.input;
				return { ...toolCall, toolName: resolved, input: repairedInputStr };
			}
		}

		// Stage 5: route to `invalid` pseudo-tool.
		const errMsg = error?.message ?? 'Unknown tool name';
		return {
			...toolCall,
			toolName: INVALID_TOOL_NAME,
			input: JSON.stringify({ tool: raw, error: errMsg }),
		};
	};

	// One request for both transports: the stream below and, when OpenAI will not stream it, the same
	// request whole (see the catch). Built once, so the repeat cannot ask the model anything different.
	const callOptions = {
		model: languageModel,
		// Top-level `system` (Anthropic-style). AI SDK routes this to the
		// request's top-level `system` field for @ai-sdk/anthropic and
		// prepends as a system role for openai-compatible. Avoids the
		// "System messages in the prompt or messages fields can be a
		// security risk" warning AND ensures minimax/Anthropic-protocol
		// models actually see the tool instructions (previously dropped
		// when system was inside messages array on the Anthropic path).
		// On the @ai-sdk/anthropic route the system rides INSIDE messages
		// instead (with a cache_control breakpoint) — see systemForCall above.
		system: systemForCall,
		messages: modelMessages,
		// The only system message in `messages` is our own prompt, moved there to carry a cache breakpoint
		// (see above); history system turns are dropped in conversion. Declared so the SDK stops warning
		// about injection on every cached request.
		allowSystemInMessages: true,
		tools,
		activeTools,
		...(hasProviderOptions ? { providerOptions } : {}),
		...(maxOutputTokens ? { maxOutputTokens } : {}),
		toolChoice,
		abortSignal: abortController.signal,
		...modelParams,
		// AI SDK default maxRetries=2 (3 attempts total) is too aggressive for
		// aggregator-proxied models (openCodeGo/zen → DeepSeek-thinking, BigPickle,
		// minimax-m2.7) — those upstreams throttle on bursts of agentic steps and
		// 3 attempts hit the same rate-limit window. 5 retries = 6 attempts with
		// AI SDK's exp backoff (2^n: 0s / 2s / 4s / 8s / 16s / 32s ≈ ~60s spread),
		// giving the upstream window time to reset. Doesn't affect non-throttled
		// cases — successful first attempt skips backoff entirely.
		maxRetries: 5,
		experimental_repairToolCall: repairToolCall,
	};

	try {
		const result = streamText(callOptions);

		for await (const part of result.fullStream as AsyncIterable<TextStreamPart<ToolSet>>) {
			if (timeoutFired) { break; }
			markConnected(); // ANY part means the upstream answered → clear connection timeout

			switch (part.type) {
				case 'text-start': {
					// A second text block of one answer (Claude interleaves text with thinking): kept apart from
					// the first, or two sentences would run into each other.
					if (fullTextSoFar) { fullTextSoFar += '\n\n'; }
					break;
				}
				case 'text-delta': {
					markContent(); // content flowing → (re)arm the inter-token stall timer
					fullTextSoFar += part.text ?? '';
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'reasoning-start': {
					reasoningCollector.start(part.id, part.providerMetadata);
					if (fullReasoningSoFar) { fullReasoningSoFar += '\n\n'; }
					// A redacted block has no words to show; it is marked so the fold does not look like the model skipped thinking.
					if ((part.providerMetadata as { anthropic?: { redactedData?: unknown } } | undefined)?.anthropic?.redactedData !== undefined) {
						fullReasoningSoFar += '[redacted_thinking]';
					}
					break;
				}
				case 'reasoning-delta': {
					markContent();
					reasoningCollector.delta(part.id, part.text ?? '', part.providerMetadata);
					fullReasoningSoFar += part.text ?? '';
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'reasoning-end': {
					reasoningCollector.end(part.id, part.providerMetadata);
					break;
				}
				case 'tool-input-start': {
					// Single-slot accumulator: one tool call per turn.
					// Additional tool calls in the same response are intentionally ignored
					// — the consumer pipeline downstream only handles one tool per turn.
					if (toolName) { break; }
					toolName = part.toolName ?? '';
					toolId = part.id ?? '';
					markContent();
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'tool-input-delta': {
					if (toolId && part.id !== toolId) { break; }
					// Arguments streaming IS the answer flowing: a large file write streams for minutes, and
					// without this reset the idle timer cut it 45 s after the call began.
					markContent();
					toolParamsStr += part.delta ?? '';
					onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
					break;
				}
				case 'tool-call': {
					// SDK delivers the fully-parsed input. Prefer it for the final call;
					// keeps us correct even when tool-input-delta wasn't emitted at all.
					if (!toolName && part.toolName) {
						toolName = part.toolName;
						toolId = part.toolCallId ?? toolId;
					}
					if (part.toolCallId === toolId || !toolId) {
						toolCallComplete = true;
					}
					toolSignature ??= googleThoughtSignatureOf((part as { providerMetadata?: unknown }).providerMetadata);
					const input = part.input;
					if (input !== undefined) {
						try { toolParamsStr = JSON.stringify(input); }
						catch { /* keep accumulated */ }
					}
					break;
				}
				case 'finish-step':
				case 'finish': {
					lastFinishReason = part.finishReason ?? lastFinishReason;
					lastRawFinishReason = part.rawFinishReason ?? lastRawFinishReason;
					if (part.type === 'finish-step') {
						lastFinishMetadata = part.providerMetadata ?? lastFinishMetadata;
					}
					// AI SDK v5+ (we are on `ai: ^6.0.182`) renamed `promptTokens`→`inputTokens`
					// and `completionTokens`→`outputTokens`. Old field names are kept as
					// fallback for any provider/path still on v4 shape. `finish-step` fires
					// per step (multi-step agentic loops), `finish` fires once at end — the
					// latter wins for totals; keep last seen on this combined branch.
					// Also try `totalUsage` (some SDK versions surface aggregate on `finish`
					// under a separate field).
					const usageSource = part.type === 'finish-step' ? part.usage : part.totalUsage;
					const u = usageSource as {
						inputTokens?: number; outputTokens?: number; totalTokens?: number;
						promptTokens?: number; completionTokens?: number;
						cachedInputTokens?: number;
						inputTokenDetails?: { cacheWriteTokens?: number };
					} | undefined;
					if (u) {
						const inTok = typeof u.inputTokens === 'number' ? u.inputTokens
							: typeof u.promptTokens === 'number' ? u.promptTokens : undefined;
						const outTok = typeof u.outputTokens === 'number' ? u.outputTokens
							: typeof u.completionTokens === 'number' ? u.completionTokens : undefined;
						const totTok = typeof u.totalTokens === 'number' ? u.totalTokens : undefined;
						// AI SDK v5+ surfaces provider prompt-cache hits as `cachedInputTokens`.
						const cachedTok = typeof u.cachedInputTokens === 'number' ? u.cachedInputTokens : undefined;
						// AI SDK 6 reports cache WRITES apart, in `inputTokenDetails`, and counts them inside
						// `inputTokens` — the whole prompt, for every provider. The compatible wire leaves the
						// field empty; `cacheWriteTokensExtractor` read it off the raw usage instead.
						const extractedWrites = (lastFinishMetadata as Record<string, { cacheWriteTokens?: unknown } | undefined> | undefined)?.[USAGE_METADATA_KEY]?.cacheWriteTokens;
						const cacheWriteTok = typeof u.inputTokenDetails?.cacheWriteTokens === 'number' ? u.inputTokenDetails.cacheWriteTokens
							: typeof extractedWrites === 'number' ? extractedWrites : undefined;
						if (typeof inTok === 'number' || typeof outTok === 'number' || typeof totTok === 'number') {
							lastUsage = {
								promptTokens: typeof inTok === 'number' ? inTok : lastUsage?.promptTokens,
								completionTokens: typeof outTok === 'number' ? outTok : lastUsage?.completionTokens,
								totalTokens: typeof totTok === 'number' ? totTok : lastUsage?.totalTokens,
								cachedInputTokens: typeof cachedTok === 'number' ? cachedTok : lastUsage?.cachedInputTokens,
								cacheWriteTokens: typeof cacheWriteTok === 'number' ? cacheWriteTok : lastUsage?.cacheWriteTokens,
							};
						}
						// One-time debug log: surface the exact shape returned by the
						// provider on the very first usage we see. Helps confirm field
						// names per provider without re-reading the SDK source. Cleared
						// once `lastUsage` is set so we don't spam.
						else {
							vibeLog.warn('usage', 'received but unrecognized shape', {
								part: part.type, keys: Object.keys(u), raw: u,
							});
						}
					}
					break;
				}
				case 'error': {
					throw part.error;
				}
			}
		}

		if (timeoutFired) { return; }
		clearAllTimers();
		deliverAnswer();
	} catch (streamError) {
		clearAllTimers();
		if (timeoutDeliveredPartial) { return; }
		if (abortController.signal.aborted && !timeoutFired) {
			// User-initiated abort — propagate nothing, the caller already knows.
			return;
		}
		let error: unknown = streamError;
		// OpenAI lets an organisation it has not verified call reasoning models but not STREAM them. The same
		// request without a stream is allowed, so it is repeated once, quietly: the answer is the same, it just
		// arrives whole. Kept from the OpenAI client this route replaced.
		if (openAIWire && !contentStarted && UNVERIFIED_ORG_STREAM_REFUSAL.test(errorTextOf(streamError))) {
			try {
				const result = await generateText(callOptions);
				fullTextSoFar = result.text;
				fullReasoningSoFar = result.reasoningText ?? '';
				const call = result.toolCalls[0];
				if (call) {
					toolName = call.toolName;
					toolId = call.toolCallId;
					toolParamsStr = JSON.stringify(call.input ?? {});
					toolCallComplete = true;
				}
				lastFinishReason = result.finishReason;
				lastRawFinishReason = result.rawFinishReason;
				lastFinishMetadata = result.providerMetadata;
				lastUsage = usageOfTotals(result.usage);
				onText({ fullText: fullTextSoFar, fullReasoning: fullReasoningSoFar, toolCall: buildPartialToolCallObj() });
				deliverAnswer();
				return;
			} catch (retryError) {
				if (abortController.signal.aborted) { return; }
				error = retryError;
			}
		}
		// AI SDK error objects expose a loose, version-dependent surface (retry
		// wrappers, nested API errors, parsed body). Read them through an
		// optional-everything view rather than `any`.
		const errorView = (error ?? {}) as AiSdkErrorView;
		// AI SDK wraps exhausted retries in an AI_RetryError whose own `.message`
		// is "Failed after N attempts. Last error: <none>" and which carries NO
		// `statusCode` — the real HTTP status (e.g. 520 from a Cloudflare-fronted
		// aggregator origin) lives on the nested AI_APICallError in `.lastError` /
		// `.errors[]`. Unwrap to that inner error so the status mapping below sees
		// the truth instead of surfacing the useless "<none>" wrapper text.
		const inner: AiSdkErrorView | undefined = errorView.lastError
			?? (Array.isArray(errorView.errors) && errorView.errors.length > 0 ? errorView.errors[errorView.errors.length - 1] : undefined);
		const httpStatus = errorView.statusCode ?? errorView.status ?? inner?.statusCode ?? inner?.status;
		// A 429 we re-statused to stop in-place retries is reported as what it is — a rate limit — so the
		// chat's pause waits out the vendor's `retry-after` instead of stopping the run.
		const status = Number((errorView.responseHeaders ?? inner?.responseHeaders)?.[ORIGINAL_STATUS_HEADER]) === 429 ? 429 : httpStatus;
		const innerMsg: string | undefined = typeof inner?.message === 'string' ? inner.message : undefined;
		const outerMsg: string = errorView.message ?? String(error);
		// Prefer the inner error's message when the outer one is the retry wrapper.
		const errMsg: string = (innerMsg && innerMsg.trim().length > 0) ? innerMsg : outerMsg;
		const errBody: string = typeof errorView.responseBody === 'string' ? errorView.responseBody
			: (typeof inner?.responseBody === 'string' ? inner.responseBody : '');
		// The provider's response BODY often carries the REAL reason while the status code
		// lies (observed: openCodeGo 401 with body «Free promotion has ended for Qwen3.6 Plus
		// Free…» — a static «Invalid API key» message hid it). Prefer `data.error.message`
		// (AI SDK pre-parses it) with a raw-JSON-body fallback.
		const bodyErrMsg: string | undefined = (() => {
			const data = errorView.data ?? inner?.data;
			if (typeof data?.error?.message === 'string' && data.error.message.trim().length > 0) { return data.error.message.trim(); }
			if (errBody) {
				try {
					const parsed = JSON.parse(errBody) as { error?: { message?: unknown }; message?: unknown };
					const m = parsed?.error?.message ?? parsed?.message;
					if (typeof m === 'string' && m.trim().length > 0) { return m.trim(); }
				} catch { /* body is not JSON — ignore */ }
			}
			return undefined;
		})();
		// Detect context-overflow first — same regex catalogue used downstream,
		// applied here BEFORE generic status mapping so a 413 or a 400 with a
		// known overflow body gets the specialized message.
		// Same reasoning as on the empty-stream path: the observed request rate and the
		// provider's own body code travel with EVERY refusal, so the chat can judge structurally
		// instead of regex-matching the message text.
		const diag = lastDiagnostics ? { diagnostics: lastDiagnostics } : {};
		// No status and a network code down the cause chain: the request never reached the provider. Named
		// in the form the send layer recognises (sendLLMMessage.ts), which adds the likely cause — a local
		// server that is not running, TLS interception, a blocked network.
		// After exhausted retries the network error sits under the retry wrapper's `lastError`, not its `cause`.
		const connectionFailure = status === undefined ? describeConnectionError(inner ?? error) ?? describeConnectionError(error) : undefined;
		if (connectionFailure) {
			vibeLog.warn('aiSdkAdapter', `connection failure ${providerName}/${modelName}: ${connectionFailure}`);
			onError({ message: `APIConnectionError: ${connectionFailure}`, fullError: error instanceof Error ? error : null, ...diag });
		} else if (status === 413 || isContextOverflow(errMsg) || isContextOverflow(errBody)) {
			onError({
				message: buildContextOverflowError(providerName, modelName, errMsg.slice(0, 200)),
				fullError: error instanceof Error ? error : null,
				...diag,
			});
		} else if (status === 401) {
			// Body message wins: a 401 is not always a bad key (ended free promotion, model
			// gating). Fall back to the static invalid-key text only when the body is silent.
			onError({ message: bodyErrMsg ?? `Invalid ${providerName} API key.`, fullError: error instanceof Error ? error : null, ...diag });
		} else if (status === 429) {
			const msg = bodyErrMsg ?? ((errMsg && errMsg.trim().length > 0) ? errMsg : 'Rate limit exceeded. Please wait a moment before trying again.');
			onError({ message: `Rate limit exceeded: ${msg}`, fullError: error instanceof Error ? error : null, ...diag });
		} else if (typeof status === 'number' && status >= 500) {
			// 5xx — the provider/origin is down or erroring (e.g. 520 from an
			// aggregator origin). Surface the status explicitly so the user knows
			// it's the provider, not their request, instead of the retry wrapper's
			// "Failed after N attempts. Last error: <none>".
			onError({
				message: `Provider unavailable (HTTP ${status}) for ${providerName}/${modelName} — the upstream did not respond. Retry shortly or switch the model.`,
				fullError: error instanceof Error ? error : null,
				...diag,
			});
		} else {
			onError({ message: errMsg, fullError: error instanceof Error ? error : null, ...diag });
		}
	}
};
