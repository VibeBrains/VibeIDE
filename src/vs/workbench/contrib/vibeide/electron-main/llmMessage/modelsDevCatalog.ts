/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// models.dev catalog — data-driven AI SDK package routing for aggregator providers.
//
// Problem this solves: aggregators like opencode.ai/zen/go expose multiple wire
// protocols on the same baseURL (OpenAI chat-completions on `/chat/completions`,
// Anthropic Messages on `/messages`). Per-model protocol mismatch causes silent
// degeneration: model emits numeric tool names ("0"/"1"/"5") and empty params.
// The official routing table is documented but not exposed via any /v1/models
// endpoint of the aggregator. The community registry **models.dev** does have
// it: under each provider, individual models can override `provider.npm` with
// the AI SDK package they need (e.g. `@ai-sdk/anthropic` for minimax-m2.7).
//
// This module fetches that registry once per process, caches in memory, and
// exposes a baseURL+modelName → SDK package lookup. No hardcoded model names,
// no regex by family, no per-version maintenance. New models in models.dev
// inherit the right SDK automatically; new aggregator providers that show up
// in models.dev are matched by baseURL.
//
// Failure mode: if models.dev is unreachable or returns malformed JSON, the
// lookup returns `undefined` and the caller falls back to its default SDK
// (openai-compatible for our adapter). Network timeout is 10s; cache is held
// for the process lifetime (re-fetched on next process start).
//
// Source: https://models.dev/api.json (schema: `{<providerId>: {api, npm,
// models: {<modelId>: {provider?: {npm}}}}}`).

import { fetch as undiciFetch } from 'undici';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 10_000;

// Per-model SDK npm override (from `models[].provider.npm`). Key is model id
// lowercased; value is e.g. '@ai-sdk/anthropic'. If a model has no override
// it's absent here — caller should consult `getProviderDefaultNpm()`.
type ProviderModelNpmMap = ReadonlyMap<string, string>;

interface CatalogIndex {
	readonly byApiUrl: ReadonlyMap<string, { providerId: string; defaultNpm: string; models: ProviderModelNpmMap }>;
}

let catalogPromise: Promise<CatalogIndex | null> | null = null;

const normaliseUrl = (url: string): string => url.replace(/\/+$/, '');

const fetchAndIndex = async (): Promise<CatalogIndex | null> => {
	let json: unknown;
	try {
		const res = await undiciFetch(MODELS_DEV_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		json = await res.json();
	} catch {
		return null;
	}
	if (!json || typeof json !== 'object') return null;
	const byApiUrl = new Map<string, { providerId: string; defaultNpm: string; models: ProviderModelNpmMap }>();
	for (const providerId of Object.keys(json as Record<string, unknown>)) {
		const provider = (json as Record<string, unknown>)[providerId];
		if (!provider || typeof provider !== 'object') continue;
		const p = provider as { api?: unknown; npm?: unknown; models?: unknown };
		if (typeof p.api !== 'string' || typeof p.npm !== 'string') continue;
		const modelNpm = new Map<string, string>();
		if (p.models && typeof p.models === 'object') {
			for (const modelId of Object.keys(p.models as Record<string, unknown>)) {
				const m = (p.models as Record<string, unknown>)[modelId];
				if (!m || typeof m !== 'object') continue;
				const override = (m as { provider?: { npm?: unknown } }).provider?.npm;
				if (typeof override === 'string') {
					modelNpm.set(modelId.toLowerCase(), override);
				}
			}
		}
		byApiUrl.set(normaliseUrl(p.api), { providerId, defaultNpm: p.npm, models: modelNpm });
	}
	return { byApiUrl };
};

const getCatalog = (): Promise<CatalogIndex | null> => {
	if (!catalogPromise) catalogPromise = fetchAndIndex();
	return catalogPromise;
};

/**
 * Look up the AI SDK package (`@ai-sdk/anthropic`, `@ai-sdk/openai-compatible`,
 * etc.) for a model on a given aggregator baseURL. Matches the aggregator by
 * exact `api` URL match in models.dev, then resolves per-model override or
 * provider default.
 *
 * Returns `undefined` when:
 *   - models.dev fetch failed (offline / 5xx / timeout) — caller should use
 *     its own default SDK.
 *   - baseURL isn't registered in models.dev — same.
 *   - model isn't listed under that provider — same (use provider default
 *     via `getProviderDefaultNpm`).
 */
export const getModelSdkNpm = async (baseURL: string, modelName: string): Promise<string | undefined> => {
	const catalog = await getCatalog();
	if (!catalog) return undefined;
	const provider = catalog.byApiUrl.get(normaliseUrl(baseURL));
	if (!provider) return undefined;
	return provider.models.get(modelName.toLowerCase()) ?? provider.defaultNpm;
};

/**
 * Force-refresh the catalog. Useful for tests; in production the lazy
 * process-lifetime cache is sufficient.
 */
export const _refreshCatalogForTests = (): void => {
	catalogPromise = null;
};
