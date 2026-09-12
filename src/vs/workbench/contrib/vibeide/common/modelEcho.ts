/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Which model actually answered.
 *
 * We ask for a model by id and count the price by that id, but between us and the vendor there can
 * be a proxy, an aggregator and our own failover chain, and a substitution is silent: the answer
 * simply comes from somewhere else. Every wire reports what it served, so it is compared with what
 * was asked and a mismatch is said out loud — once, not on every turn.
 *
 * The comparison is deliberately forgiving, because an honest answer often renames the same model:
 * an alias resolves to a dated build (`gpt-4o` → `gpt-4o-2024-08-06`) and an aggregator prefixes the
 * vendor (`openai/gpt-4o`). Crying "substituted" on those would teach the owner to ignore the line,
 * and an ignored warning is worse than none.
 *
 * The rule is VibeIDEA's, ported word for word together with its test vector (`ModelEcho.kt`,
 * decision #88 in their journal): the same answer must read the same way in both products.
 */

const SEPARATORS = '-_:@.';

/** How much of the answer's head is read looking for the model name. */
const ANSWERED_MODEL_PEEK_CHARS = 8_192;

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** OpenAI-compatible wires carry it at the top level of every chunk and of a whole answer. */
export function modelFromOpenAiChunk(chunk: unknown): string | undefined {
	return nonEmptyString(asRecord(chunk)?.model);
}

/** Anthropic says it once, inside `message_start`. */
export function modelFromAnthropicEvent(event: unknown): string | undefined {
	return nonEmptyString(asRecord(asRecord(event)?.message)?.model);
}

/** Gemini repeats it in every event as `modelVersion`. */
export function modelFromGeminiEvent(event: unknown): string | undefined {
	return nonEmptyString(asRecord(event)?.modelVersion);
}

/** `openai/gpt-4o` and `gpt-4o` are one model behind an aggregator's namespace. */
function tail(id: string): string {
	const slash = id.lastIndexOf('/');
	return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * `gpt-4o` against `gpt-4o-2024-08-06`: the same alias, resolved to a dated build.
 *
 * The tail decides. A build marker starts with digits (`2024-08-06`, `002`, `0905-preview`), while a
 * word tail is another model — `gpt-4o-mini` is not `gpt-4o`, and reading that as a rename would hide
 * the very substitution worth knowing about.
 */
function variantOf(base: string, longer: string): boolean {
	if (longer.length <= base.length || !longer.startsWith(base)) {
		return false;
	}
	if (!SEPARATORS.includes(longer[base.length])) {
		return false;
	}
	let head = '';
	for (const ch of longer.slice(base.length + 1)) {
		if (SEPARATORS.includes(ch)) {
			break;
		}
		head += ch;
	}
	return head.length > 0 && /^[0-9]+$/.test(head);
}

/** True when `answered` is a different model, not another spelling of `requested`. */
export function isModelSubstituted(requested: string, answered: string | undefined): boolean {
	const asked = tail((requested ?? '').trim().toLowerCase());
	const got = tail((answered ?? '').trim().toLowerCase());
	if (!asked || !got) {
		return false;
	}
	return !(asked === got || variantOf(asked, got) || variantOf(got, asked));
}

/**
 * The model named in the head of a provider's answer, whatever the wire: a whole JSON body, an SSE
 * stream of chunks, an Anthropic `message_start`, a Gemini event.
 *
 * Lines are read as JSON first, because that is exact. A head cut mid-object never parses, and a
 * non-streaming answer is one big object — so a plain scan for the field is the fallback rather than
 * the method: reading the name matters more than reading it elegantly.
 */
export function readAnsweredModel(head: string): string | undefined {
	for (const line of head.split(/\r?\n/)) {
		const payload = (line.startsWith('data:') ? line.slice('data:'.length) : line).trim();
		if (!payload.startsWith('{')) {
			continue;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			continue;
		}
		const named = modelFromOpenAiChunk(parsed) ?? modelFromAnthropicEvent(parsed) ?? modelFromGeminiEvent(parsed);
		if (named) {
			return named;
		}
	}
	const scanned = /"(?:model|modelVersion)"\s*:\s*"([^"]{1,120})"/.exec(head);
	return nonEmptyString(scanned?.[1]);
}

export { ANSWERED_MODEL_PEEK_CHARS };
