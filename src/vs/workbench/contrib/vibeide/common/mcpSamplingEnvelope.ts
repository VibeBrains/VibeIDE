/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeMCPSamplingService` — `sampling/createMessage` request/response envelope
 * (roadmap §"Real-impl tail / Phase 3b — `VibeMCPSamplingService` wire в
 * `mcpChannel.ts` (sampling/elicitation де-факто отсутствует)").
 *
 * MCP protocol — sampling spec: server → client → IDE LLM. Pure helpers
 * (`vscode`-free) decode the wire shape and validate consent fields, so the
 * `mcpChannel.ts` adapter only does the JSON-RPC plumbing.
 *
 * Spec reference: https://modelcontextprotocol.io/specification/server/sampling
 */

export type SamplingRole = 'user' | 'assistant';

export interface SamplingMessage {
	readonly role: SamplingRole;
	readonly content: SamplingContent;
}

export type SamplingContent =
	| { readonly type: 'text'; readonly text: string }
	| { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export interface ModelPreferences {
	readonly hints?: ReadonlyArray<{ readonly name?: string }>;
	readonly costPriority?: number;
	readonly speedPriority?: number;
	readonly intelligencePriority?: number;
}

export interface SamplingRequest {
	readonly messages: ReadonlyArray<SamplingMessage>;
	readonly modelPreferences?: ModelPreferences;
	readonly systemPrompt?: string;
	readonly includeContext?: 'none' | 'thisServer' | 'allServers';
	readonly temperature?: number;
	readonly maxTokens?: number;
	readonly stopSequences?: ReadonlyArray<string>;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SamplingResponse {
	readonly model: string;
	readonly stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens' | string;
	readonly role: SamplingRole;
	readonly content: SamplingContent;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

const MAX_TOKENS_HARD_CAP = 1_000_000;
const MAX_PROMPT_LENGTH = 1_000_000;
const TEMPERATURE_MIN = 0;
const TEMPERATURE_MAX = 2;

/**
 * Pure decoder for `sampling/createMessage` request payload. Refuses any
 * malformation up-front so the channel adapter never forwards a bogus
 * shape to the user-consent flow.
 */
export function decodeSamplingRequest(raw: unknown): DecodeResult<SamplingRequest> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;

	if (!Array.isArray(o.messages) || o.messages.length === 0) {
		return { ok: false, reason: 'messages-empty' };
	}
	const messages: SamplingMessage[] = [];
	for (let i = 0; i < o.messages.length; i++) {
		const msg = decodeMessage(o.messages[i]);
		if (!msg.ok) { return { ok: false, reason: `messages[${i}]:${msg.reason}` }; }
		messages.push(msg.value);
	}

	let modelPreferences: ModelPreferences | undefined;
	if (o.modelPreferences !== undefined) {
		const decoded = decodeModelPreferences(o.modelPreferences);
		if (!decoded.ok) { return { ok: false, reason: `modelPreferences:${decoded.reason}` }; }
		modelPreferences = decoded.value;
	}

	let systemPrompt: string | undefined;
	if (o.systemPrompt !== undefined) {
		if (typeof o.systemPrompt !== 'string') { return { ok: false, reason: 'systemPrompt-not-string' }; }
		if (o.systemPrompt.length > MAX_PROMPT_LENGTH) { return { ok: false, reason: 'systemPrompt-too-long' }; }
		systemPrompt = o.systemPrompt;
	}

	let includeContext: SamplingRequest['includeContext'];
	if (o.includeContext !== undefined) {
		if (o.includeContext !== 'none' && o.includeContext !== 'thisServer' && o.includeContext !== 'allServers') {
			return { ok: false, reason: 'includeContext-invalid' };
		}
		includeContext = o.includeContext;
	}

	let temperature: number | undefined;
	if (o.temperature !== undefined) {
		if (typeof o.temperature !== 'number' || !Number.isFinite(o.temperature) || o.temperature < TEMPERATURE_MIN || o.temperature > TEMPERATURE_MAX) {
			return { ok: false, reason: 'temperature-out-of-range' };
		}
		temperature = o.temperature;
	}

	let maxTokens: number | undefined;
	if (o.maxTokens !== undefined) {
		if (typeof o.maxTokens !== 'number' || !Number.isInteger(o.maxTokens) || o.maxTokens <= 0 || o.maxTokens > MAX_TOKENS_HARD_CAP) {
			return { ok: false, reason: 'maxTokens-out-of-range' };
		}
		maxTokens = o.maxTokens;
	}

	let stopSequences: readonly string[] | undefined;
	if (o.stopSequences !== undefined) {
		if (!Array.isArray(o.stopSequences) || !o.stopSequences.every(s => typeof s === 'string')) {
			return { ok: false, reason: 'stopSequences-invalid' };
		}
		stopSequences = o.stopSequences.slice() as string[];
	}

	let metadata: Readonly<Record<string, unknown>> | undefined;
	if (o.metadata !== undefined) {
		if (!o.metadata || typeof o.metadata !== 'object' || Array.isArray(o.metadata)) {
			return { ok: false, reason: 'metadata-not-object' };
		}
		metadata = { ...(o.metadata as Record<string, unknown>) };
	}

	const value: SamplingRequest = {
		messages,
		...(modelPreferences !== undefined ? { modelPreferences } : {}),
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
		...(includeContext !== undefined ? { includeContext } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(stopSequences !== undefined ? { stopSequences } : {}),
		...(metadata !== undefined ? { metadata } : {}),
	};
	return { ok: true, value };
}

function decodeMessage(raw: unknown): DecodeResult<SamplingMessage> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-object' }; }
	const o = raw as Record<string, unknown>;
	if (o.role !== 'user' && o.role !== 'assistant') { return { ok: false, reason: 'role-invalid' }; }
	const c = decodeContent(o.content);
	if (!c.ok) { return { ok: false, reason: `content:${c.reason}` }; }
	return { ok: true, value: { role: o.role, content: c.value } };
}

function decodeContent(raw: unknown): DecodeResult<SamplingContent> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-object' }; }
	const o = raw as Record<string, unknown>;
	if (o.type === 'text') {
		if (typeof o.text !== 'string') { return { ok: false, reason: 'text-not-string' }; }
		return { ok: true, value: { type: 'text', text: o.text } };
	}
	if (o.type === 'image') {
		if (typeof o.data !== 'string' || o.data.length === 0) { return { ok: false, reason: 'image-data-empty' }; }
		if (typeof o.mimeType !== 'string' || !/^image\//.test(o.mimeType)) { return { ok: false, reason: 'image-mime-invalid' }; }
		return { ok: true, value: { type: 'image', data: o.data, mimeType: o.mimeType } };
	}
	return { ok: false, reason: 'type-unknown' };
}

function decodeModelPreferences(raw: unknown): DecodeResult<ModelPreferences> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-object' }; }
	const o = raw as Record<string, unknown>;
	const value: { hints?: ReadonlyArray<{ name?: string }>; costPriority?: number; speedPriority?: number; intelligencePriority?: number } = {};
	if (o.hints !== undefined) {
		if (!Array.isArray(o.hints)) { return { ok: false, reason: 'hints-not-array' }; }
		value.hints = o.hints.map((h: unknown) => {
			if (h && typeof h === 'object' && typeof (h as { name?: unknown }).name === 'string') {
				return { name: (h as { name: string }).name };
			}
			return {};
		});
	}
	for (const k of ['costPriority', 'speedPriority', 'intelligencePriority'] as const) {
		if (o[k] !== undefined) {
			const n = o[k];
			if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
				return { ok: false, reason: `${k}-out-of-range` };
			}
			value[k] = n;
		}
	}
	return { ok: true, value };
}

// -----------------------------------------------------------------------------
// Response envelope (server returns to client after the IDE samples its model)
// -----------------------------------------------------------------------------

export function decodeSamplingResponse(raw: unknown): DecodeResult<SamplingResponse> {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.model !== 'string' || o.model.length === 0) { return { ok: false, reason: 'model-missing' }; }
	if (o.role !== 'user' && o.role !== 'assistant') { return { ok: false, reason: 'role-invalid' }; }
	const c = decodeContent(o.content);
	if (!c.ok) { return { ok: false, reason: `content:${c.reason}` }; }
	const value: SamplingResponse = {
		model: o.model,
		role: o.role,
		content: c.value,
		...(typeof o.stopReason === 'string' ? { stopReason: o.stopReason } : {}),
	};
	return { ok: true, value };
}

// -----------------------------------------------------------------------------
// Consent decision (sampling crosses trust boundary — IDE's LLM accessed by
// MCP server, so user must approve)
// -----------------------------------------------------------------------------

export type SamplingConsentDecision =
	| { readonly kind: 'auto-allow'; readonly reason: 'server-trusted' | 'context-none' }
	| { readonly kind: 'require-confirm'; readonly reason: 'image-content' | 'context-cross-server' | 'first-time-server' | 'high-token-budget' };

export interface SamplingConsentInput {
	readonly request: SamplingRequest;
	readonly serverTrustState: 'trusted' | 'unknown';
	readonly perServerSamplingApproved: boolean;
	readonly highTokenThreshold?: number;
}

/**
 * Pure decision: should the user be prompted for consent before this
 * sampling request? `auto-allow` only when ALL three conditions hold:
 *   - server is trusted
 *   - request has includeContext: 'none' OR 'thisServer'
 *   - no image content in any message
 *   - estimated tokens within highTokenThreshold (default 50_000)
 */
export function decideSamplingConsent(input: SamplingConsentInput): SamplingConsentDecision {
	const threshold = input.highTokenThreshold ?? 50_000;
	const hasImage = input.request.messages.some(m => m.content.type === 'image');
	if (hasImage) {
		return { kind: 'require-confirm', reason: 'image-content' };
	}
	if (input.request.includeContext === 'allServers') {
		return { kind: 'require-confirm', reason: 'context-cross-server' };
	}
	if (input.serverTrustState !== 'trusted' || !input.perServerSamplingApproved) {
		return { kind: 'require-confirm', reason: 'first-time-server' };
	}
	if (typeof input.request.maxTokens === 'number' && input.request.maxTokens > threshold) {
		return { kind: 'require-confirm', reason: 'high-token-budget' };
	}
	if (input.request.includeContext === undefined || input.request.includeContext === 'none') {
		return { kind: 'auto-allow', reason: 'context-none' };
	}
	return { kind: 'auto-allow', reason: 'server-trusted' };
}
