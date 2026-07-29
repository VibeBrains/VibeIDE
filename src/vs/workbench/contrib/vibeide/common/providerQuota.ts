/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Passive quota tracking — pure decision layer.
 *
 * Providers report how much of the key's rate limit is left on EVERY response, not just on 429.
 * We used to look at `retry-after` only after a refusal, so the context meter knew our own token
 * count and nothing about the key itself — the user learned about a limit by hitting it.
 *
 * This module only parses headers and judges them. Reading the response and showing the numbers
 * happens elsewhere (`aiSdkAdapter` / the chat UI), so this stays testable without a network.
 */

/** How the numbers were reported — kept for the tooltip so we never present a guess as a fact. */
export type ProviderQuotaKind = 'requests' | 'tokens' | 'input-tokens' | 'output-tokens';

export type ProviderQuotaBucket = {
	kind: ProviderQuotaKind;
	remaining: number;
	/** Absent when the provider reports only the remainder (some gateways do). */
	limit?: number;
	/** Unix ms when this bucket refills, if the provider said so. */
	resetsAt?: number;
};

export type ProviderQuotaSnapshot = {
	buckets: ProviderQuotaBucket[];
	/** `retry-after` in seconds — present on refusals and on some pre-emptive throttles. */
	retryAfterSec?: number;
	/** Unix ms the snapshot was taken; the UI ages it out rather than showing stale numbers. */
	observedAt: number;
};

/** Below this share of the limit the UI warns before the request is refused. */
export const QUOTA_LOW_RATIO = 0.1;

/** A snapshot older than this tells us nothing about the current state — the UI drops it. */
export const QUOTA_STALE_MS = 10 * 60 * 1000;

const HEADER_MAP: ReadonlyArray<{ remaining: string; limit?: string; reset?: string; kind: ProviderQuotaKind }> = [
	// Anthropic
	{ kind: 'requests', remaining: 'anthropic-ratelimit-requests-remaining', limit: 'anthropic-ratelimit-requests-limit', reset: 'anthropic-ratelimit-requests-reset' },
	{ kind: 'tokens', remaining: 'anthropic-ratelimit-tokens-remaining', limit: 'anthropic-ratelimit-tokens-limit', reset: 'anthropic-ratelimit-tokens-reset' },
	{ kind: 'input-tokens', remaining: 'anthropic-ratelimit-input-tokens-remaining', limit: 'anthropic-ratelimit-input-tokens-limit', reset: 'anthropic-ratelimit-input-tokens-reset' },
	{ kind: 'output-tokens', remaining: 'anthropic-ratelimit-output-tokens-remaining', limit: 'anthropic-ratelimit-output-tokens-limit', reset: 'anthropic-ratelimit-output-tokens-reset' },
	// OpenAI and the aggregators that copy its shape
	{ kind: 'requests', remaining: 'x-ratelimit-remaining-requests', limit: 'x-ratelimit-limit-requests', reset: 'x-ratelimit-reset-requests' },
	{ kind: 'tokens', remaining: 'x-ratelimit-remaining-tokens', limit: 'x-ratelimit-limit-tokens', reset: 'x-ratelimit-reset-tokens' },
	// RFC 9238-style generic headers (some gateways, OpenRouter among them)
	{ kind: 'requests', remaining: 'ratelimit-remaining', limit: 'ratelimit-limit', reset: 'ratelimit-reset' },
];

const num = (raw: string | undefined): number | undefined => {
	if (raw === undefined) { return undefined; }
	const n = Number(raw.trim());
	return Number.isFinite(n) ? n : undefined;
};

/**
 * Reset fields come in three shapes across providers: an RFC 3339 timestamp (Anthropic),
 * seconds-from-now (RFC style), or OpenAI's duration string (`1m30s`, `6ms`). Anything we
 * cannot read confidently is dropped — a wrong refill time is worse than none.
 */
export function parseResetToUnixMs(raw: string | undefined, now: number): number | undefined {
	if (!raw) { return undefined; }
	const value = raw.trim();
	if (!value) { return undefined; }

	const duration = /^(?:(?<h>\d+(?:\.\d+)?)h)?(?:(?<m>\d+(?:\.\d+)?)m(?!s))?(?:(?<s>\d+(?:\.\d+)?)s)?(?:(?<ms>\d+(?:\.\d+)?)ms)?$/.exec(value);
	if (duration && (duration.groups?.h || duration.groups?.m || duration.groups?.s || duration.groups?.ms)) {
		const g = duration.groups!;
		const ms = (Number(g.h ?? 0) * 3600 + Number(g.m ?? 0) * 60 + Number(g.s ?? 0)) * 1000 + Number(g.ms ?? 0);
		return now + ms;
	}

	const plain = num(value);
	if (plain !== undefined) {
		// A bare number is seconds-from-now, except when it is clearly an epoch value.
		if (plain > 1e12) { return plain; }          // epoch ms
		if (plain > 1e9) { return plain * 1000; }    // epoch seconds
		return now + plain * 1000;
	}

	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export type HeaderLookup = (name: string) => string | undefined;

/** Accepts anything header-shaped: a `Headers`, a plain record, or a lookup function. */
export function toHeaderLookup(source: Headers | Record<string, string> | HeaderLookup): HeaderLookup {
	if (typeof source === 'function') { return source; }
	if (typeof (source as Headers).get === 'function') {
		const headers = source as Headers;
		return name => headers.get(name) ?? undefined;
	}
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(source as Record<string, string>)) { lower[k.toLowerCase()] = v; }
	return name => lower[name.toLowerCase()];
}

/**
 * Builds a snapshot from response headers. Returns `undefined` when the provider reported
 * nothing usable — callers must keep the previous snapshot rather than show zeros.
 */
export function parseProviderQuotaHeaders(
	source: Headers | Record<string, string> | HeaderLookup,
	now: number,
): ProviderQuotaSnapshot | undefined {
	const get = toHeaderLookup(source);
	const buckets: ProviderQuotaBucket[] = [];
	const seen = new Set<ProviderQuotaKind>();

	for (const entry of HEADER_MAP) {
		// First provider wins per kind: the specific vendor headers are listed before the
		// generic ones, and a gateway may echo both with different meanings.
		if (seen.has(entry.kind)) { continue; }
		const remaining = num(get(entry.remaining));
		if (remaining === undefined) { continue; }
		seen.add(entry.kind);
		const limit = entry.limit ? num(get(entry.limit)) : undefined;
		const resetsAt = entry.reset ? parseResetToUnixMs(get(entry.reset), now) : undefined;
		buckets.push({
			kind: entry.kind,
			remaining,
			...(limit !== undefined ? { limit } : {}),
			...(resetsAt !== undefined ? { resetsAt } : {}),
		});
	}

	const retryAfterSec = num(get('retry-after'));

	if (!buckets.length && retryAfterSec === undefined) { return undefined; }

	return {
		buckets,
		...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
		observedAt: now,
	};
}

export function isQuotaStale(snapshot: ProviderQuotaSnapshot, now: number): boolean {
	return now - snapshot.observedAt > QUOTA_STALE_MS;
}

/**
 * The bucket the user should be warned about: the one closest to running out. Buckets without
 * a limit cannot be expressed as a share, so they only count when the remainder is literally 0.
 */
export function tightestBucket(snapshot: ProviderQuotaSnapshot): ProviderQuotaBucket | undefined {
	let tightest: ProviderQuotaBucket | undefined;
	let tightestRatio = Number.POSITIVE_INFINITY;
	for (const bucket of snapshot.buckets) {
		const ratio = bucket.limit && bucket.limit > 0
			? bucket.remaining / bucket.limit
			: (bucket.remaining <= 0 ? 0 : Number.POSITIVE_INFINITY);
		if (ratio < tightestRatio) { tightestRatio = ratio; tightest = bucket; }
	}
	return tightest;
}

/** True when the key is close enough to its limit that the next request may be refused. */
export function isQuotaLow(snapshot: ProviderQuotaSnapshot, now: number): boolean {
	if (isQuotaStale(snapshot, now)) { return false; }
	const bucket = tightestBucket(snapshot);
	if (!bucket) { return false; }
	if (bucket.remaining <= 0) { return true; }
	return !!bucket.limit && bucket.limit > 0 && bucket.remaining / bucket.limit <= QUOTA_LOW_RATIO;
}
