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
// Failure mode: if models.dev is unreachable AND no local snapshot is found,
// the lookup returns `undefined` and the caller falls back to its default SDK
// (openai-compatible for our adapter). Network timeout is 10s; success is held
// for the process lifetime, failures are retried after a cooldown.
//
// Offline fallback: when network fetch fails we look for a user-supplied snapshot
// in this order, taking the first that parses:
//   1. <userData>/models.dev.json — VS Code-style per-user override
//   2. <exeDir>/models.dev.json — "drop a file next to VibeIDE.exe", easiest for
//      users behind a corporate firewall who can download models.dev/api.json
//      from a different network (e.g. home VPN) and copy it in.
// (A bundled snapshot in resources/ is a separate build-pipeline change.)
//
// Source: https://models.dev/api.json (schema: `{<providerId>: {api, npm,
// models: {<modelId>: {provider?: {npm}}}}}`).

import { fetch as undiciFetch } from 'undici';
import * as fs from 'fs';
import * as path from 'path';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const FETCH_TIMEOUT_MS = 10_000;
const LOCAL_SNAPSHOT_FILENAME = 'models.dev.json';
// Disk-cache TTL for the userData snapshot. Within this window we serve from
// disk INSTANTLY (no network wait) and kick off a background refresh — the
// classic stale-while-revalidate pattern. 24h is the roadmap-suggested
// default: aggregators don't add models more than ~once per week, but a daily
// refresh keeps catalogue rot under control without hammering models.dev.
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Per-model SDK npm override (from `models[].provider.npm`). Key is model id
// lowercased; value is e.g. '@ai-sdk/anthropic'. If a model has no override
// it's absent here — caller should consult `getProviderDefaultNpm()`.
type ProviderModelNpmMap = ReadonlyMap<string, string>;

interface CatalogIndex {
	readonly byApiUrl: ReadonlyMap<string, { providerId: string; defaultNpm: string; models: ProviderModelNpmMap }>;
}

// Success is cached for process lifetime. Failures are NOT cached permanently:
// if the first fetch failed (offline at startup, models.dev 5xx, DNS), every
// subsequent caller would otherwise see `null` forever, silently degrading
// aggregator providers that need per-model SDK routing (e.g. openCode + minimax-m2.x
// without `@ai-sdk/anthropic` returns empty responses). On failure we record the
// timestamp and let the next call retry after a cooldown.
let cachedCatalog: CatalogIndex | null = null;
let inFlight: Promise<CatalogIndex | null> | null = null;
let lastFailureAt = 0;
const NEGATIVE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

const normaliseUrl = (url: string): string => url.replace(/\/+$/, '');

const indexJson = (json: unknown): CatalogIndex | null => {
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
	return byApiUrl.size > 0 ? { byApiUrl } : null;
};

const fetchAndIndex = async (): Promise<{ index: CatalogIndex; rawText: string } | null> => {
	try {
		const res = await undiciFetch(MODELS_DEV_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		// Read as text first so we can both parse AND persist verbatim. Avoids a
		// re-stringify (which would reformat / lose unknown fields).
		const rawText = await res.text();
		const index = indexJson(JSON.parse(rawText));
		return index ? { index, rawText } : null;
	} catch {
		return null;
	}
};

// Persist the just-fetched catalog to <userData>/models.dev.json so the next
// offline start can fall back to it without any user action. Best-effort: any
// failure (no userData dir, ENOSPC, EPERM) is swallowed — write is an
// optimisation, not a correctness requirement.
const persistSnapshotToUserData = async (rawText: string): Promise<void> => {
	const userData = resolveUserDataDir();
	if (!userData) return;
	try {
		await fs.promises.mkdir(userData, { recursive: true });
		await fs.promises.writeFile(path.join(userData, LOCAL_SNAPSHOT_FILENAME), rawText, 'utf-8');
	} catch { /* best-effort, ignore */ }
};

// Mirror of telemetryStorage.ts userData resolution — keeps modelsDevCatalog a
// dependency-free module without pulling in IEnvironmentMainService DI.
const resolveUserDataDir = (): string | null => {
	const envOverride = process.env.VSCODE_USER_DATA_PATH;
	if (envOverride) return envOverride;
	if (process.platform === 'darwin' && process.env.HOME) {
		return path.join(process.env.HOME, 'Library', 'Application Support', 'VibeIDE');
	}
	if (process.platform === 'win32' && process.env.APPDATA) {
		return path.join(process.env.APPDATA, 'VibeIDE');
	}
	if (process.env.HOME) {
		return path.join(process.env.HOME, '.config', 'VibeIDE');
	}
	return null;
};

const localSnapshotCandidates = (): string[] => {
	const out: string[] = [];
	const userData = resolveUserDataDir();
	if (userData) out.push(path.join(userData, LOCAL_SNAPSHOT_FILENAME));
	try {
		const exeDir = path.dirname(process.execPath);
		if (exeDir) out.push(path.join(exeDir, LOCAL_SNAPSHOT_FILENAME));
	} catch { /* process.execPath unavailable — skip */ }
	// Bundled snapshot inside the Electron resources dir. Two candidate layouts
	// because VS Code-style builds keep app code under `resources/app/...` while
	// vanilla Electron apps put assets directly under `resources/...`. We try
	// both — first match wins, missing is harmless (falls through to next).
	const resourcesPath: string | undefined = (process as any).resourcesPath;
	if (typeof resourcesPath === 'string' && resourcesPath) {
		out.push(path.join(resourcesPath, 'app', 'resources', 'vibeide', LOCAL_SNAPSHOT_FILENAME));
		out.push(path.join(resourcesPath, 'vibeide', LOCAL_SNAPSHOT_FILENAME));
	}
	return out;
};

const tryReadLocalSnapshot = async (): Promise<{ catalog: CatalogIndex; from: string } | null> => {
	for (const p of localSnapshotCandidates()) {
		try {
			const raw = await fs.promises.readFile(p, 'utf-8');
			const indexed = indexJson(JSON.parse(raw));
			if (indexed) return { catalog: indexed, from: p };
		} catch { /* missing / invalid — try next candidate */ }
	}
	return null;
};

// Fast-path read of the userData snapshot ONLY, plus its age. Used by the
// stale-while-revalidate fast start: if the snapshot was written within
// DISK_CACHE_TTL_MS, serve it immediately and skip the synchronous network
// fetch on cold start (a background refresh runs anyway). userData is the
// only candidate we wrote ourselves — exeDir / resourcesPath bundles were
// placed by a human and we have no provenance on their freshness, so they
// stay on the slow path (network-fail fallback) only.
const tryReadFreshUserDataSnapshot = async (): Promise<{ catalog: CatalogIndex; from: string; ageMs: number } | null> => {
	const userData = resolveUserDataDir();
	if (!userData) return null;
	const file = path.join(userData, LOCAL_SNAPSHOT_FILENAME);
	try {
		const stat = await fs.promises.stat(file);
		const ageMs = Date.now() - stat.mtimeMs;
		if (ageMs > DISK_CACHE_TTL_MS) return null;
		const raw = await fs.promises.readFile(file, 'utf-8');
		const indexed = indexJson(JSON.parse(raw));
		if (!indexed) return null;
		return { catalog: indexed, from: file, ageMs };
	} catch {
		return null;
	}
};

// Fire-and-forget background refresh: pull fresh catalogue from network and
// update both the in-memory cache and the userData snapshot. Errors are
// swallowed — caller is using the stale snapshot, so a refresh failure just
// means the next start will retry. Never runs concurrently with itself.
let backgroundRefreshRunning = false;
const refreshInBackground = (): void => {
	if (backgroundRefreshRunning) return;
	backgroundRefreshRunning = true;
	void (async () => {
		try {
			const fresh = await fetchAndIndex();
			if (fresh) {
				cachedCatalog = fresh.index;
				lastFailureAt = 0;
				loadedFromLocalPath = null;
				await persistSnapshotToUserData(fresh.rawText);
			}
		} finally {
			backgroundRefreshRunning = false;
		}
	})();
};

const getCatalog = (): Promise<CatalogIndex | null> => {
	if (cachedCatalog) return Promise.resolve(cachedCatalog);
	if (inFlight) return inFlight;
	if (lastFailureAt > 0 && Date.now() - lastFailureAt < NEGATIVE_RETRY_COOLDOWN_MS) {
		return Promise.resolve(null);
	}
	inFlight = (async () => {
		// Fast path — stale-while-revalidate. If we have a userData snapshot
		// younger than DISK_CACHE_TTL_MS, serve it INSTANTLY (no network wait)
		// and kick off a background refresh so the next start gets newer data
		// AND this session picks up any new models mid-flight. This drops cold-
		// start LLM-request latency by ~500ms on warm runs.
		const fresh = await tryReadFreshUserDataSnapshot();
		if (fresh) {
			cachedCatalog = fresh.catalog;
			lastFailureAt = 0;
			loadedFromLocalPath = fresh.from;
			console.warn(`[modelsDevCatalog] served fresh userData snapshot from ${fresh.from} (age ${Math.floor(fresh.ageMs / 1000)}s); refreshing in background`);
			refreshInBackground();
			inFlight = null;
			return fresh.catalog;
		}

		const fromNetwork = await fetchAndIndex();
		if (fromNetwork) {
			cachedCatalog = fromNetwork.index;
			lastFailureAt = 0;
			loadedFromLocalPath = null;
			// Fire-and-forget: snapshot for next offline boot. Not awaited so the
			// LLM call doesn't pay disk-write latency on every cold start.
			void persistSnapshotToUserData(fromNetwork.rawText);
			inFlight = null;
			return fromNetwork.index;
		}
		// Network failed — try local snapshot before giving up. A local snapshot
		// is treated as a success: we cache it for the process lifetime, so the
		// retry cooldown does not apply (no point retrying network if user is
		// known offline; they restart VibeIDE when they want a fresh catalog).
		const local = await tryReadLocalSnapshot();
		if (local) {
			cachedCatalog = local.catalog;
			lastFailureAt = 0;
			loadedFromLocalPath = local.from;
			console.warn(`[modelsDevCatalog] network fetch failed; loaded local snapshot from ${local.from}`);
			inFlight = null;
			return local.catalog;
		}
		lastFailureAt = Date.now();
		console.warn(
			`[modelsDevCatalog] network fetch failed and no local snapshot found. ` +
			`Per-model SDK routing falls back to openai-compatible (aggregator-proxied minimax/qwen may return empty responses). ` +
			`Download ${MODELS_DEV_URL} and save as "${LOCAL_SNAPSHOT_FILENAME}" in one of: ${localSnapshotCandidates().join(' | ')}`
		);
		inFlight = null;
		return null;
	})();
	return inFlight;
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
	cachedCatalog = null;
	inFlight = null;
	lastFailureAt = 0;
	loadedFromLocalPath = null;
};

// Where the in-memory catalog actually came from. Set when getCatalog() resolves.
// Consumed by the status IPC channel so the renderer can decide whether to surface
// a toast ("network down, using offline snapshot from X" or "no snapshot at all").
let loadedFromLocalPath: string | null = null;

export type ModelsDevCatalogStatus =
	| { state: 'unloaded' }
	| { state: 'loaded_from_network' }
	| { state: 'loaded_from_local'; path: string }
	| { state: 'failed'; candidatePaths: string[]; catalogUrl: string };

/**
 * Snapshot of how the in-memory catalog was loaded. Safe to call multiple times.
 * If called before any prior `getModelSdkNpm` request, this triggers the first
 * fetch — useful for prefetching at app start so the renderer can warn early.
 */
export const getCatalogStatus = async (): Promise<ModelsDevCatalogStatus> => {
	const catalog = await getCatalog();
	if (!catalog) {
		return { state: 'failed', candidatePaths: localSnapshotCandidates(), catalogUrl: MODELS_DEV_URL };
	}
	if (loadedFromLocalPath) {
		return { state: 'loaded_from_local', path: loadedFromLocalPath };
	}
	return { state: 'loaded_from_network' };
};
