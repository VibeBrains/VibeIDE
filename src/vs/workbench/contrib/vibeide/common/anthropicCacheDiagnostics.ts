/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Anthropic's own view of why the prompt cache missed (cache diagnostics, GA)
 *
 * The request names the previous response, `diagnostics: {previous_message_id}`, and the answer's `message_start` carries
 * `diagnostics.cache_miss_reason`: the earliest point where this request diverged from that one
 * (platform.claude.com/docs/en/build-with-claude/cache-diagnostics). Our own prefix checks see only our side of the
 * request; this names what the vendor saw — another model, an edited system prompt, a changed tool set
 * Only Anthropic's own API: Bedrock, Vertex and the compatible routes do not promise the field
 */

import { localize } from '../../../../nls.js';

/** The kinds of divergence the vendor names; the first four are something the request changed */
export type CacheMissKind = 'model_changed' | 'system_changed' | 'tools_changed' | 'messages_changed' | 'previous_message_not_found' | 'unavailable';

export interface CacheMissDiagnosis {
	readonly kind: CacheMissKind;
	/** Input tokens that were not read from the cache because of the divergence; only for the four changes */
	readonly missedInputTokens?: number;
}

const KINDS: readonly CacheMissKind[] = ['model_changed', 'system_changed', 'tools_changed', 'messages_changed', 'previous_message_not_found', 'unavailable'];
const CHANGES: ReadonlySet<CacheMissKind> = new Set(['model_changed', 'system_changed', 'tools_changed', 'messages_changed']);

export interface AnthropicMessageStart {
	/** `msg_…` — sent back as `previous_message_id` on the next turn */
	readonly id?: string;
	/** Absent when nothing diverged, no comparison was asked for, or the comparison had not finished yet */
	readonly cacheMiss?: CacheMissDiagnosis;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * The `message_start` event at the head of a streamed answer, or undefined while it has not arrived
 * `diagnostics: null` and `cache_miss_reason: null` both mean «nothing to report»: no divergence, or a comparison
 * that finished after the answer started
 */
export function readAnthropicMessageStart(head: string): AnthropicMessageStart | undefined {
	for (const line of head.split(/\r?\n/)) {
		const payload = line.startsWith('data:') ? line.slice('data:'.length).trim() : '';
		if (!payload.startsWith('{') || !payload.includes('"message_start"')) {
			continue;
		}
		let event: Record<string, unknown> | undefined;
		try {
			event = record(JSON.parse(payload));
		} catch {
			// A line cut at the end of the chunk: the next chunk brings the rest
			return undefined;
		}
		if (event?.type !== 'message_start') {
			continue;
		}
		const message = record(event.message);
		const id = typeof message?.id === 'string' && message.id ? message.id : undefined;
		const reason = record(record(message?.diagnostics)?.cache_miss_reason);
		const kind = KINDS.find(k => k === reason?.type);
		const missed = reason?.cache_missed_input_tokens;
		const cacheMiss: CacheMissDiagnosis | undefined = kind
			? { kind, ...(typeof missed === 'number' && Number.isFinite(missed) ? { missedInputTokens: missed } : {}) }
			: undefined;
		return { ...(id ? { id } : {}), ...(cacheMiss ? { cacheMiss } : {}) };
	}
	return undefined;
}

/** Whether a diagnosis is worth a line in the chat: a change the request made, which cost cached tokens */
export function isCostlyCacheMiss(diagnosis: CacheMissDiagnosis | undefined): diagnosis is CacheMissDiagnosis {
	return !!diagnosis && CHANGES.has(diagnosis.kind) && (diagnosis.missedInputTokens ?? 0) > 0;
}

/** The chat line for a costly miss, one thought per line; the text is for the reader, nothing decides by it */
export function describeCacheMiss(diagnosis: CacheMissDiagnosis): string {
	const what = diagnosis.kind === 'model_changed'
		? localize('vibeide.cacheMiss.model', "сменилась модель")
		: diagnosis.kind === 'system_changed'
			? localize('vibeide.cacheMiss.system', "изменился системный промпт")
			: diagnosis.kind === 'tools_changed'
				? localize('vibeide.cacheMiss.tools', "изменился набор инструментов")
				: localize('vibeide.cacheMiss.messages', "изменилась история разговора");
	return [
		localize('vibeide.cacheMiss.title', "**Кэш промпта не прочитался: {0}**", what),
		localize('vibeide.cacheMiss.tokens', "По словам Anthropic, по полной цене оплачено {0} входных токенов, которые могли прийти из кэша", diagnosis.missedInputTokens ?? 0),
	].join('\n\n');
}
