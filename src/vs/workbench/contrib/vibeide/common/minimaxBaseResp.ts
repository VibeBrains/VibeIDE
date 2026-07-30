/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MiniMax reports failures on TWO independent channels: the HTTP status AND a business code
 * inside the response body (`base_resp.status_code`, success = `0`). A refusal can therefore
 * arrive inside an HTTP 200 — indistinguishable from "the model simply stopped" unless the
 * body is read. That is exactly how a rate limit could hide behind our generic
 * "Empty response (reason: stop)" error for months (see docs/knowledge/chatUx/modelStalls.md,
 * incident #001 onwards: the TPM/RPM hypothesis was written down and never verified because
 * nothing captured the body).
 *
 * Pure parsing + classification only — reading the network happens in `aiSdkAdapter`, so this
 * stays testable without a socket.
 *
 * Sources (deliberately recorded, because they CONTRADICT each other):
 *  - Error table: https://platform.minimax.io/docs/api-reference/errorcode
 *    → 1002 "rate limit", 1039 "token limit", 1041 "conn limit", 2045 "rate growth limit",
 *      2056 "usage limit exceeded".
 *  - Response schema: https://platform.minimax.io/docs/api-reference/text-chat-openai.md
 *    → documents `base_resp` itself, plus 1013 "internal server error".
 *  - MiniMax's own CLI: https://raw.githubusercontent.com/MiniMax-AI/cli/main/ERRORS.md
 *    → maps 1002/1039 to a SENSITIVITY FILTER (not limits!), and knows 1028/1030
 *      ("quota exhausted") and 2061 ("model not on your plan") which the public table omits.
 *
 * The 1002/1039 conflict is real and unresolved by the vendor. We default to the API error
 * table (the primary reference for the API itself) and let `status_msg` break the tie, marking
 * the verdict `ambiguous` so no caller presents a guess as a fact.
 */

/** Success sentinel — MiniMax sets this on every healthy response. */
export const MINIMAX_BASE_RESP_OK = 0;

export type MiniMaxRefusalKind =
	| 'ok'
	| 'rate-limit'
	| 'quota'
	| 'content-filter'
	| 'auth'
	| 'server'
	| 'timeout'
	| 'invalid-params'
	| 'unknown';

export type MiniMaxBaseResp = {
	code: number;
	/** `status_msg` verbatim; absent when the provider sent an empty string. */
	message?: string;
};

export type MiniMaxRefusal = MiniMaxBaseResp & {
	kind: MiniMaxRefusalKind;
	/** True when the code alone was not decisive and `message` had to break the tie. */
	ambiguous: boolean;
};

/**
 * Codes whose meaning is undisputed across both vendor sources. The ambiguous pair
 * (1002/1039) is handled separately in `classifyMiniMaxBaseResp`.
 */
const UNDISPUTED_KIND_OF_CODE = new Map<number, MiniMaxRefusalKind>([
	[1041, 'rate-limit'],        // conn limit — concurrent connections
	[2045, 'rate-limit'],        // rate growth limit
	[2056, 'quota'],             // usage limit exceeded
	[1028, 'quota'],             // quota exhausted (CLI only)
	[1030, 'quota'],             // quota exhausted (CLI only)
	[1008, 'quota'],             // insufficient balance
	[1004, 'auth'],              // not authorized / token mismatch
	[2061, 'auth'],              // model not available on the current plan
	[1000, 'server'],
	[1013, 'server'],
	[1024, 'server'],
	[1033, 'server'],
	[1001, 'timeout'],
	[2013, 'invalid-params'],
	[1026, 'content-filter'],    // input content flagged
	[1027, 'content-filter'],    // output content flagged
]);

/** Codes the vendor's own two references disagree about: limit (API table) vs filter (CLI). */
const DISPUTED_LIMIT_OR_FILTER = new Map<number, MiniMaxRefusalKind>([
	[1002, 'rate-limit'],        // API table: "rate limit"  | CLI: sensitivity filter
	[1039, 'quota'],             // API table: "token limit" | CLI: sensitivity filter
]);

/** Wording that only ever appears on a content-moderation refusal. */
const FILTER_HINT = /sensitiv|filter|flagged|moderat|risk|敏感|违规/i;

/** Wording that only ever appears on a throughput/quota refusal. */
const LIMIT_HINT = /\brate\b|\blimit|\btpm\b|\brpm\b|\bqps\b|frequen|quota|exceed|限流|超出/i;

/**
 * Classifies a parsed `base_resp`. Never throws — an unrecognised code yields `'unknown'`
 * rather than a wrong bucket, because a wrong verdict here would send the chat down the
 * wrong recovery path (waiting out a limit that never existed, say).
 */
export function classifyMiniMaxBaseResp(base: MiniMaxBaseResp): MiniMaxRefusal {
	if (base.code === MINIMAX_BASE_RESP_OK) {
		return { ...base, kind: 'ok', ambiguous: false };
	}

	const undisputed = UNDISPUTED_KIND_OF_CODE.get(base.code);
	if (undisputed) {
		return { ...base, kind: undisputed, ambiguous: false };
	}

	const disputed = DISPUTED_LIMIT_OR_FILTER.get(base.code);
	if (disputed) {
		const msg = base.message ?? '';
		// An explicit filter phrase overrides the API table; an explicit limit phrase confirms
		// it. With no phrase at all we keep the table's reading but stay flagged as ambiguous.
		if (FILTER_HINT.test(msg) && !LIMIT_HINT.test(msg)) {
			return { ...base, kind: 'content-filter', ambiguous: true };
		}
		return { ...base, kind: disputed, ambiguous: !LIMIT_HINT.test(msg) };
	}

	return { ...base, kind: 'unknown', ambiguous: false };
}

/** True when this refusal means "the key ran out of allowance", in either of its two flavours. */
export function isMiniMaxThrottleKind(kind: MiniMaxRefusalKind): boolean {
	return kind === 'rate-limit' || kind === 'quota';
}

const readBaseRespObject = (value: unknown): MiniMaxBaseResp | undefined => {
	if (!value || typeof value !== 'object') { return undefined; }
	const holder = value as { base_resp?: unknown };
	const base = holder.base_resp;
	if (!base || typeof base !== 'object') { return undefined; }
	const { status_code: code, status_msg: message } = base as { status_code?: unknown; status_msg?: unknown };
	if (typeof code !== 'number' || !Number.isFinite(code)) { return undefined; }
	const text = typeof message === 'string' ? message.trim() : '';
	return { code, ...(text ? { message: text } : {}) };
};

/**
 * Pulls `base_resp` out of a raw response body. Handles both shapes we can meet:
 * a plain JSON object (non-streaming replies and most error bodies) and an SSE transcript
 * (`data: {...}` lines) where the field rides along with an ordinary chunk.
 *
 * The LAST non-ok `base_resp` wins: a stream may open with `status_code: 0` and only later
 * carry the refusal, and it is the refusal we need. Truncated trailing JSON — routine when we
 * only keep a bounded tail of a long stream — is skipped rather than throwing.
 */
export function extractMiniMaxBaseResp(rawBody: string | undefined): MiniMaxBaseResp | undefined {
	if (!rawBody) { return undefined; }

	const tryParse = (text: string): MiniMaxBaseResp | undefined => {
		const trimmed = text.trim();
		if (!trimmed || trimmed === '[DONE]') { return undefined; }
		try {
			return readBaseRespObject(JSON.parse(trimmed));
		} catch {
			return undefined; // partial or non-JSON fragment — expected on a bounded tail
		}
	};

	let lastOk: MiniMaxBaseResp | undefined;
	let lastRefusal: MiniMaxBaseResp | undefined;

	const remember = (found: MiniMaxBaseResp | undefined) => {
		if (!found) { return; }
		if (found.code === MINIMAX_BASE_RESP_OK) { lastOk = found; } else { lastRefusal = found; }
	};

	// Whole-body JSON first: an error reply is usually a single object, not a stream.
	remember(tryParse(rawBody));

	for (const line of rawBody.split('\n')) {
		const payload = line.startsWith('data:') ? line.slice('data:'.length) : undefined;
		if (payload !== undefined) { remember(tryParse(payload)); }
	}

	return lastRefusal ?? lastOk;
}

/** Convenience wrapper: parse a raw body and classify in one step. */
export function readMiniMaxRefusal(rawBody: string | undefined): MiniMaxRefusal | undefined {
	const base = extractMiniMaxBaseResp(rawBody);
	return base ? classifyMiniMaxBaseResp(base) : undefined;
}
