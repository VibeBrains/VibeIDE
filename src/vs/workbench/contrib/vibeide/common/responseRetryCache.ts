/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Local response retry cache (1186) — pure helper.
 *
 * When a stream dies after the first chunk has already arrived, retrying
 * the request from scratch wastes the user's wait time and tokens. This
 * cache stores the partial chunks per request key; on retry, the runtime
 * computes a "resume-from" handle that the provider can use:
 *
 *   - Anthropic: `prefill` with the accumulated text (server resumes
 *     generation continuing the assistant's draft).
 *   - OpenAI / generic: drop the partial and replay the user message,
 *     skipping in the rendered output what we already have.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type ResumeStrategy = 'prefill' | 'replay-skip-rendered' | 'restart-from-scratch';

export interface PartialResponse {
	requestKey: string;
	startedAt: number;
	updatedAt: number;
	chunks: string[];
	totalChars: number;
}

export interface RetryCacheConfig {
	/** Hard cap on entries before LRU eviction. Default 16. */
	maxEntries: number;
	/** TTL — older entries are dropped on retry attempt. Default 10 min. */
	ttlMs: number;
	/** Hard cap on accumulated characters per entry. Default 200 KB. */
	maxCharsPerEntry: number;
}

export const RETRY_CACHE_DEFAULTS: RetryCacheConfig = {
	maxEntries: 16,
	ttlMs: 10 * 60 * 1000,
	maxCharsPerEntry: 200_000,
};

export type ResumeDecision =
	| { kind: 'no-partial' }
	| { kind: 'expired-partial'; previousChars: number }
	| { kind: 'resume-prefill'; prefill: string; recoveredChars: number }
	| { kind: 'resume-replay'; alreadyRenderedChars: number };

/**
 * Decide how to resume a request given any cached partial. Pure.
 *
 * `now` is injected so tests are deterministic. `providerSupportsPrefill`
 * comes from the capability registry — set true for Anthropic and the
 * OpenAI Chat Completions `assistant` continuation, false for everything
 * else.
 */
export function decideResume(
	partial: PartialResponse | undefined,
	providerSupportsPrefill: boolean,
	now: number,
	config: RetryCacheConfig = RETRY_CACHE_DEFAULTS,
): ResumeDecision {
	if (!partial || partial.chunks.length === 0) {
		return { kind: 'no-partial' };
	}
	const ageMs = now - partial.updatedAt;
	if (ageMs > config.ttlMs) {
		return { kind: 'expired-partial', previousChars: partial.totalChars };
	}
	if (providerSupportsPrefill) {
		const prefill = partial.chunks.join('');
		return { kind: 'resume-prefill', prefill, recoveredChars: prefill.length };
	}
	return { kind: 'resume-replay', alreadyRenderedChars: partial.totalChars };
}

/**
 * Append a new chunk to an existing partial. Pure — returns a new
 * partial, never mutates input. Drops the oldest chunks if the entry
 * exceeds `maxCharsPerEntry`.
 */
export function appendChunk(
	partial: PartialResponse | undefined,
	requestKey: string,
	chunk: string,
	now: number,
	config: RetryCacheConfig = RETRY_CACHE_DEFAULTS,
): PartialResponse {
	const base: PartialResponse = partial ?? {
		requestKey,
		startedAt: now,
		updatedAt: now,
		chunks: [],
		totalChars: 0,
	};
	const chunks = [...base.chunks, chunk];
	let totalChars = base.totalChars + chunk.length;
	while (totalChars > config.maxCharsPerEntry && chunks.length > 1) {
		const dropped = chunks.shift()!;
		totalChars -= dropped.length;
	}
	return {
		requestKey,
		startedAt: base.startedAt,
		updatedAt: now,
		chunks,
		totalChars,
	};
}

/**
 * Apply LRU + TTL maintenance to a cache map. Pure — returns a new map
 * with stale entries dropped and oldest entries evicted past the cap.
 */
export function evictRetryCache(
	cache: ReadonlyMap<string, PartialResponse>,
	now: number,
	config: RetryCacheConfig = RETRY_CACHE_DEFAULTS,
): Map<string, PartialResponse> {
	const fresh = new Map<string, PartialResponse>();
	for (const [key, value] of cache.entries()) {
		if (now - value.updatedAt <= config.ttlMs) {
			fresh.set(key, value);
		}
	}
	while (fresh.size > config.maxEntries) {
		// Drop the oldest by updatedAt.
		let oldestKey: string | undefined;
		let oldestUpdatedAt = Infinity;
		for (const [k, v] of fresh.entries()) {
			if (v.updatedAt < oldestUpdatedAt) {
				oldestUpdatedAt = v.updatedAt;
				oldestKey = k;
			}
		}
		if (oldestKey === undefined) { break; }
		fresh.delete(oldestKey);
	}
	return fresh;
}
