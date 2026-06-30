/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


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

import { vibeLog } from '../../common/vibeLog.js';
import { fetch as undiciFetch } from 'undici';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { LOCAL_SNAPSHOT_FILENAME, MODELS_DEV_URL } from '../../common/modelsDevCatalogConstants.js';

const FETCH_TIMEOUT_MS = 10_000;
// Disk-cache TTL for the userData snapshot. Within this window we serve from
// disk INSTANTLY (no network wait) and kick off a background refresh — the
// classic stale-while-revalidate pattern. Default 24h: aggregators don't add
// models more than ~once per week, but a daily refresh keeps catalogue rot
// under control without hammering models.dev. Configurable per-process via
// the `VIBEIDE_MODELS_DEV_CACHE_TTL_HOURS` env var, which the renderer
// populates from `vibeide.catalog.modelsDevCacheTtlHours` setting at startup.
// Env-var indirection chosen over importing IConfigurationService because
// modelsDevCatalog is a module-level singleton without DI; env var also
// survives the renderer ↔ main IPC boundary without extra plumbing.
const DEFAULT_DISK_CACHE_TTL_HOURS = 24;
const resolveDiskCacheTtlMs = (): number => {
	const raw = process.env.VIBEIDE_MODELS_DEV_CACHE_TTL_HOURS;
	if (!raw) { return DEFAULT_DISK_CACHE_TTL_HOURS * 60 * 60 * 1000; }
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) { return DEFAULT_DISK_CACHE_TTL_HOURS * 60 * 60 * 1000; }
	// Clamp to the same range as the setting (1h..720h = 30 days).
	const clamped = Math.max(1, Math.min(720, parsed));
	return clamped * 60 * 60 * 1000;
};

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
// aggregator providers that need per-model SDK routing (e.g. openCodeGo + minimax-m2.x
// without `@ai-sdk/anthropic` returns empty responses). On failure we record the
// timestamp and let the next call retry after a cooldown.
let cachedCatalog: CatalogIndex | null = null;
let inFlight: Promise<CatalogIndex | null> | null = null;
let lastFailureAt = 0;
const NEGATIVE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

const normaliseUrl = (url: string): string => url.replace(/\/+$/, '');

const indexJson = (json: unknown): CatalogIndex | null => {
	if (!json || typeof json !== 'object') { return null; }
	const byApiUrl = new Map<string, { providerId: string; defaultNpm: string; models: ProviderModelNpmMap }>();
	for (const providerId of Object.keys(json as Record<string, unknown>)) {
		const provider = (json as Record<string, unknown>)[providerId];
		if (!provider || typeof provider !== 'object') { continue; }
		const p = provider as { api?: unknown; npm?: unknown; models?: unknown };
		if (typeof p.api !== 'string' || typeof p.npm !== 'string') { continue; }
		const modelNpm = new Map<string, string>();
		if (p.models && typeof p.models === 'object') {
			for (const modelId of Object.keys(p.models as Record<string, unknown>)) {
				const m = (p.models as Record<string, unknown>)[modelId];
				if (!m || typeof m !== 'object') { continue; }
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
		if (!res.ok) {
			vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fetch returned HTTP ${res.status} ${res.statusText} — falling back to local snapshot if available`);
			return null;
		}
		// Read as text first so we can both parse AND persist verbatim. Avoids a
		// re-stringify (which would reformat / lose unknown fields).
		const rawText = await res.text();
		const index = indexJson(JSON.parse(rawText));
		if (!index) {
			vibeLog.warn('modelsDevCatalog', '[modelsDevCatalog] fetched JSON did not contain any indexable providers — falling back to local snapshot if available');
			return null;
		}
		return { index, rawText };
	} catch (e) {
		const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fetch/parse failed: ${msg} — falling back to local snapshot if available`);
		return null;
	}
};

// Persist the just-fetched catalog to <userData>/models.dev.json so the next
// offline start can fall back to it without any user action. Best-effort: any
// failure (no userData dir, ENOSPC, EPERM) is swallowed — write is an
// optimisation, not a correctness requirement.
const persistSnapshotToUserData = async (rawText: string): Promise<void> => {
	const userData = resolveUserDataDir();
	if (!userData) { return; }
	try {
		await fs.promises.mkdir(userData, { recursive: true });
		await fs.promises.writeFile(path.join(userData, LOCAL_SNAPSHOT_FILENAME), rawText, 'utf-8');
	} catch { /* best-effort, ignore */ }
};

// Mirror of telemetryStorage.ts userData resolution — keeps modelsDevCatalog a
// dependency-free module without pulling in IEnvironmentMainService DI.
const resolveUserDataDir = (): string | null => {
	const envOverride = process.env.VSCODE_USER_DATA_PATH;
	if (envOverride) { return envOverride; }
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

/**
 * Snapshot candidate priority (user policy: "drop next to exe"):
 *   1. exeDir/models.dev.json       — explicit user override next to VibeIDE.exe
 *   2. resourcesPath/app/resources/vibeide/models.dev.json — bundled snapshot
 *   3. resourcesPath/vibeide/models.dev.json — alt bundled layout
 *   4. userData/models.dev.json     — auto-written by successful network fetch
 *
 * Order matters: a user dropping a freshly downloaded `models.dev/api.json`
 * next to `VibeIDE.exe` overrides ALL other sources (including a stale
 * auto-written copy in Roaming). The auto-written copy is now a fallback,
 * not the primary path — which used to confuse corporate users who saw a
 * "loaded from Roaming/..." message and didn't know what that file was.
 */
const localSnapshotCandidates = (): { path: string; source: 'exeDir' | 'bundled' | 'userData' }[] => {
	const out: { path: string; source: 'exeDir' | 'bundled' | 'userData' }[] = [];
	try {
		const exeDir = path.dirname(process.execPath);
		if (exeDir) { out.push({ path: path.join(exeDir, LOCAL_SNAPSHOT_FILENAME), source: 'exeDir' }); }
	} catch { /* process.execPath unavailable — skip */ }
	// `resourcesPath` is injected by Electron and absent from the Node `process` typings.
	const resourcesPath: unknown = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath;
	if (typeof resourcesPath === 'string' && resourcesPath) {
		out.push({ path: path.join(resourcesPath, 'app', 'resources', 'vibeide', LOCAL_SNAPSHOT_FILENAME), source: 'bundled' });
		out.push({ path: path.join(resourcesPath, 'vibeide', LOCAL_SNAPSHOT_FILENAME), source: 'bundled' });
	}
	const userData = resolveUserDataDir();
	if (userData) { out.push({ path: path.join(userData, LOCAL_SNAPSHOT_FILENAME), source: 'userData' }); }
	return out;
};

const tryReadLocalSnapshot = async (): Promise<{ catalog: CatalogIndex; from: string; source: 'exeDir' | 'bundled' | 'userData' } | null> => {
	for (const { path: p, source } of localSnapshotCandidates()) {
		try {
			const raw = await fs.promises.readFile(p, 'utf-8');
			const indexed = indexJson(JSON.parse(raw));
			if (indexed) { return { catalog: indexed, from: p, source }; }
		} catch { /* missing / invalid — try next candidate */ }
	}
	return null;
};

// Fast-path read for cold-start: serve a local snapshot immediately and skip
// the network round-trip when possible. Honors the candidate priority:
//
//   1. exeDir — user-curated; ALWAYS served instantly (no TTL — the user
//      explicitly placed the file, freshness is their responsibility).
//   2. bundled (resourcesPath) — shipped with the install; ALWAYS served
//      instantly (release artifact, freshness is the maintainer's job).
//   3. userData — auto-written cache from a previous network success;
//      served instantly ONLY when within the configured TTL window
//      (default 24h). Stale userData falls through to the slow path so
//      we attempt network refresh.
//
// AUDIT-FIX (post-A): the previous version only checked userData,
// which meant a user dropping a freshly downloaded file next to
// VibeIDE.exe could still get a stale Roaming snapshot served on cold
// start. Now exeDir/bundled win unconditionally during fast-path.
const tryReadFastPathSnapshot = async (): Promise<{ catalog: CatalogIndex; from: string; source: 'exeDir' | 'bundled' | 'userData'; ageMs?: number } | null> => {
	for (const { path: p, source } of localSnapshotCandidates()) {
		// Distinguish "file missing" (silent skip — expected) from "file present
		// but unparseable" (warn — actionable). Missing surfaces as `ENOENT` in
		// the readFile catch; everything else is a real problem the user should
		// see in DevTools console.
		let raw: string;
		try {
			if (source === 'userData') {
				const stat = await fs.promises.stat(p);
				const ageMs = Date.now() - stat.mtimeMs;
				if (ageMs > resolveDiskCacheTtlMs()) { return null; }
				raw = await fs.promises.readFile(p, 'utf-8');
				const indexed = indexJson(JSON.parse(raw));
				if (!indexed) {
					vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fast-path: userData snapshot at ${p} parsed but lacks indexable providers; skipping`);
					return null;
				}
				return { catalog: indexed, from: p, source, ageMs };
			}
			raw = await fs.promises.readFile(p, 'utf-8');
		} catch (e: unknown) {
			// ENOENT = candidate doesn't exist — silent skip is correct.
			if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
				vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fast-path: read error at ${p} (${source})`, e);
			}
			continue;
		}
		try {
			const indexed = indexJson(JSON.parse(raw));
			if (indexed) { return { catalog: indexed, from: p, source }; }
			vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fast-path: snapshot at ${p} (${source}) parsed but lacks indexable providers; trying next candidate`);
		} catch (e) {
			vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fast-path: invalid JSON at ${p} (${source}) — fix or delete the file; trying next candidate`, e);
		}
	}
	return null;
};

// Fire-and-forget background refresh: pull fresh catalogue from network and
// update both the in-memory cache and the userData snapshot. Errors are
// swallowed — caller is using the stale snapshot, so a refresh failure just
// means the next start will retry. Never runs concurrently with itself.
let backgroundRefreshRunning = false;
const refreshInBackground = (): void => {
	if (backgroundRefreshRunning) { return; }
	backgroundRefreshRunning = true;
	void (async () => {
		try {
			const fresh = await fetchAndIndex();
			if (fresh) {
				cachedCatalog = fresh.index;
				lastFailureAt = 0;
				loadedFromLocalPath = null;
				loadedFromLocalSource = null;
				await persistSnapshotToUserData(fresh.rawText);
			}
		} finally {
			backgroundRefreshRunning = false;
		}
	})();
};

const getCatalog = (): Promise<CatalogIndex | null> => {
	if (cachedCatalog) { return Promise.resolve(cachedCatalog); }
	if (inFlight) { return inFlight; }
	if (lastFailureAt > 0 && Date.now() - lastFailureAt < NEGATIVE_RETRY_COOLDOWN_MS) {
		return Promise.resolve(null);
	}
	inFlight = (async () => {
		// Fast path — stale-while-revalidate. If we have a userData snapshot
		// younger than the configured TTL (resolveDiskCacheTtlMs(), default 24h),
		// serve it INSTANTLY (no network wait) and kick off a background refresh
		// so the next start gets newer data AND this session picks up any new
		// models mid-flight. This drops cold-start LLM-request latency by ~500ms
		// on warm runs.
		const fresh = await tryReadFastPathSnapshot();
		if (fresh) {
			cachedCatalog = fresh.catalog;
			lastFailureAt = 0;
			loadedFromLocalPath = fresh.from;
			loadedFromLocalSource = fresh.source;
			const ageNote = fresh.ageMs !== undefined ? ` (age ${Math.floor(fresh.ageMs / 1000)}s)` : '';
			vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] fast-path served ${fresh.source} snapshot from ${fresh.from}${ageNote}; refreshing in background`);
			refreshInBackground();
			inFlight = null;
			return fresh.catalog;
		}

		const fromNetwork = await fetchAndIndex();
		if (fromNetwork) {
			cachedCatalog = fromNetwork.index;
			lastFailureAt = 0;
			loadedFromLocalPath = null;
			loadedFromLocalSource = null;
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
			loadedFromLocalSource = local.source;
			vibeLog.warn('modelsDevCatalog', `[modelsDevCatalog] network fetch failed; loaded local snapshot from ${local.from} (source: ${local.source})`);
			inFlight = null;
			return local.catalog;
		}
		lastFailureAt = Date.now();
		vibeLog.warn(
			'modelsDevCatalog', `[modelsDevCatalog] network fetch failed and no local snapshot found. ` +
			`Per-model SDK routing falls back to openai-compatible (aggregator-proxied minimax/qwen may return empty responses). ` +
		`Download ${MODELS_DEV_URL} and save as "${LOCAL_SNAPSHOT_FILENAME}" in one of: ${localSnapshotCandidates().map(c => c.path).join(' | ')}`
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
	if (!catalog) { return undefined; }
	const provider = catalog.byApiUrl.get(normaliseUrl(baseURL));
	if (!provider) { return undefined; }
	return provider.models.get(modelName.toLowerCase()) ?? provider.defaultNpm;
};

/**
 * Force-refresh the catalog. Useful for tests; in production the lazy
 * process-lifetime cache is sufficient.
 */
/**
 * Drops in-memory cache and forces the next `getCatalog()` call to re-probe
 * (exeDir → bundled → userData → network). Used by:
 *  - Test suite via `recheckCatalog()` between cases to reset state.
 *  - «Recheck» Command Palette entry so users can test a freshly-placed
 *    snapshot without restarting the IDE.
 *
 * (Previously this was duplicated as `_refreshCatalogForTests` + `recheckCatalog`
 * — same behaviour, two names, source of confusion. Consolidated.)
 */
export const recheckCatalog = (): void => {
	cachedCatalog = null;
	inFlight = null;
	lastFailureAt = 0;
	loadedFromLocalPath = null;
	loadedFromLocalSource = null;
};

// Where the in-memory catalog actually came from. Set when getCatalog() resolves.
// Consumed by the status IPC channel so the renderer can decide whether to surface
// a toast ("network down, using offline snapshot from X" or "no snapshot at all").
let loadedFromLocalPath: string | null = null;
let loadedFromLocalSource: 'exeDir' | 'bundled' | 'userData' | null = null;

export type ModelsDevCatalogStatus =
	| { state: 'unloaded' }
	| { state: 'loaded_from_network' }
	| { state: 'loaded_from_local'; path: string; source: 'exeDir' | 'bundled' | 'userData' }
	| { state: 'failed'; candidatePaths: string[]; catalogUrl: string };

/**
 * Snapshot of how the in-memory catalog was loaded. Safe to call multiple times.
 * If called before any prior `getModelSdkNpm` request, this triggers the first
 * fetch — useful for prefetching at app start so the renderer can warn early.
 */
export const getCatalogStatus = async (): Promise<ModelsDevCatalogStatus> => {
	const catalog = await getCatalog();
	if (!catalog) {
		return {
			state: 'failed',
			candidatePaths: localSnapshotCandidates().map(c => c.path),
			catalogUrl: MODELS_DEV_URL,
		};
	}
	if (loadedFromLocalPath && loadedFromLocalSource) {
		return { state: 'loaded_from_local', path: loadedFromLocalPath, source: loadedFromLocalSource };
	}
	return { state: 'loaded_from_network' };
};
