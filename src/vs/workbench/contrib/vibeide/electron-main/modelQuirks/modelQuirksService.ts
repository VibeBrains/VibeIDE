/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * ModelQuirksService — main-process catalog loader for model-behaviour quirks.
 *
 * Source resolution (v0.13.17, mirrors modelsDevCatalog.ts):
 *   1. exe-adjacent `<exeDir>/model-quirks.json` — explicit user override, MAX priority.
 *   2. newer of {CDN-cache `${userData}/model-quirks-cache.json`, bundled} by top-level `date`.
 *   3. Empty catalog (no quirks; provider defaults everywhere).
 * exe-adjacent older than (2) by `date` → `staleExeAdjacent` flag → one startup toast.
 * CDN unreachable → keep cache/bundled/exe (work never halts).
 *
 * On top of the resolved catalog, the user override from `vibeide.modelQuirks` setting is
 * merged per-field (user wins). Rule matching is field-merge most-specific (see `matchQuirks`).
 *
 * Settings read ONCE at init from `${userData}/User/settings.json` — same pattern as
 * `vibeIdleWatchdogService`. Catalog status is exposed to the renderer via a ProxyChannel
 * (`vibeide-channel-modelQuirksStatus`) for the startup staleness toast + refresh command.
 */

import * as path from '../../../../../base/common/path.js';
import * as fs from 'fs';
import { parse as parseJsonc } from '../../../../../base/common/jsonc.js';
import {
	ModelQuirksCatalog,
	ResolvedModelQuirks,
	EMPTY_QUIRKS,
	applyUserOverride,
	matchQuirks,
	validateCatalog,
} from '../../common/modelQuirks/modelQuirksTypes.js';
import { loadBundledCatalog } from '../../common/modelQuirks/bundledCatalog.js';

const DEFAULT_CDN_URL = 'https://raw.githubusercontent.com/VibeBrains/VibeIDE/main/resources/model-quirks.json';
const CACHE_FILENAME = 'model-quirks-cache.json';
const DEFAULT_REFRESH_INTERVAL_HOURS = 24;

/** Fields persisted on top of the catalog JSON in userData cache (ignored at runtime). */
interface CacheMeta {
	__etag?: string;
	__fetchedAt?: number;  // epoch ms
}

let _catalog: ModelQuirksCatalog | null = null;
let _userOverride: Record<string, unknown> = {};
let _initStarted = false;
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _userDataPath = '';  // saved at init for no-arg refresh from the status channel

// Catalog provenance / freshness — for the startup staleness notification + diagnostics.
type QuirksCatalogSource = 'exeAdjacent' | 'cdn' | 'bundled' | 'empty';
let _activeSource: QuirksCatalogSource = 'empty';
let _activeDate = '';           // `date` of the active catalog
let _latestAvailableDate = '';  // newest `date` among NON-exe sources (cdn-cache / bundled / fetched)
let _staleExeAdjacent = false;  // exe-adjacent override in use but older than cdn/bundled

export interface ModelQuirksCatalogStatus {
	readonly source: QuirksCatalogSource;
	readonly activeDate: string;
	readonly latestAvailableDate: string;
	readonly staleExeAdjacent: boolean;
	readonly exeAdjacentPath: string | null;
}

interface ReadConfig {
	catalogUrl: string;
	refreshIntervalHours: number;
	userOverride: Record<string, unknown>;
}

function readSettings(userDataPath: string): ReadConfig {
	const fallback: ReadConfig = {
		catalogUrl: DEFAULT_CDN_URL,
		refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS,
		userOverride: {},
	};
	try {
		const settingsPath = path.join(userDataPath, 'User', 'settings.json');
		const raw = fs.readFileSync(settingsPath, 'utf-8');
		const parsed = parseJsonc(raw) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== 'object') { return fallback; }

		const url = parsed['vibeide.modelQuirks.catalogUrl'];
		const interval = parsed['vibeide.modelQuirks.refreshIntervalHours'];
		const override = parsed['vibeide.modelQuirks'];

		return {
			catalogUrl: typeof url === 'string' && url.length > 0 ? url : DEFAULT_CDN_URL,
			refreshIntervalHours: clampInt(interval, 0, 168, DEFAULT_REFRESH_INTERVAL_HOURS),
			userOverride: override && typeof override === 'object' && !Array.isArray(override)
				? (override as Record<string, unknown>)
				: {},
		};
	} catch {
		return fallback;
	}
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) { return fallback; }
	return Math.max(min, Math.min(max, Math.round(n)));
}

function cacheFilePath(userDataPath: string): string {
	return path.join(userDataPath, CACHE_FILENAME);
}

async function readBundled(): Promise<ModelQuirksCatalog | null> {
	// `loadBundledCatalog()` import-attribute loads `resources/model-quirks.json`
	// (resolveJsonModule + esbuild's `.json` loader inline the data into the bundle —
	// see `bundledCatalog.ts`), so it auto-mirrors the JSON including `date` with zero
	// drift. We do NOT read from disk at runtime because the gulp build doesn't copy
	// that JSON into the packaged app, and there's no stdout/stderr on Windows GUI to
	// log file-not-found errors — any `console.warn` here would EPIPE-crash the main
	// process. `resources/model-quirks.json` thus stays the single source of truth for
	// both the inlined fallback and the CDN endpoint (what `raw.githubusercontent.com`
	// serves to running IDEs).
	try {
		return validateCatalog(await loadBundledCatalog());
	} catch {
		// The bundled JSON passed compile as typed data — should never throw, but
		// defensively swallow if validateCatalog rejects a future schema breaking change.
		return null;
	}
}

const EXE_ADJACENT_FILENAME = 'model-quirks.json';

/** Path of the user-dropped override next to the executable (max priority). */
function exeAdjacentPath(): string | null {
	try {
		const dir = path.dirname(process.execPath);
		return dir ? path.join(dir, EXE_ADJACENT_FILENAME) : null;
	} catch {
		return null;
	}
}

/**
 * Read the exe-adjacent override (`<exeDir>/model-quirks.json`). Mirrors the
 * "drop a file next to VibeIDE.exe" policy of `modelsDevCatalog.ts`. Missing OR
 * invalid → null, SILENTLY: the Windows GUI main process has no stderr, so any
 * console.warn here would EPIPE-crash it (same hazard as `readBundled` documents).
 */
function readExeAdjacent(): ModelQuirksCatalog | null {
	const p = exeAdjacentPath();
	if (!p) { return null; }
	try {
		return validateCatalog(JSON.parse(fs.readFileSync(p, 'utf-8')));
	} catch {
		return null;
	}
}

/** Catalog publish date (`YYYY-MM-DD`); '' when absent → treated as oldest. ISO sorts lexicographically. */
function catalogDate(c: ModelQuirksCatalog | null | undefined): string {
	return c && typeof c.date === 'string' ? c.date : '';
}
const maxDate = (a: string, b: string): string => (a >= b ? a : b);

function readCache(userDataPath: string): { catalog: ModelQuirksCatalog | null; etag: string | undefined } {
	try {
		const raw = fs.readFileSync(cacheFilePath(userDataPath), 'utf-8');
		const parsed = JSON.parse(raw) as Record<string, unknown> & CacheMeta;
		const etag = typeof parsed.__etag === 'string' ? parsed.__etag : undefined;
		return { catalog: validateCatalog(parsed), etag };
	} catch {
		return { catalog: null, etag: undefined };
	}
}

async function fetchFromCDN(url: string, userDataPath: string, currentEtag: string | undefined): Promise<void> {
	try {
		const headers: Record<string, string> = {
			'Accept': 'application/json',
			// Polite user-agent for raw.githubusercontent.com — GH sometimes throttles
			// generic UA strings; identify ourselves.
			'User-Agent': 'VibeIDE-ModelQuirks/1',
		};
		if (currentEtag) { headers['If-None-Match'] = currentEtag; }

		const response = await fetch(url, { headers });
		if (response.status === 304) { return; }                          // not modified — keep cached
		if (!response.ok) { throw new Error(`HTTP ${response.status} ${response.statusText}`); }

		const text = await response.text();
		const parsed = JSON.parse(text);
		const validated = validateCatalog(parsed);

		// Persist with meta. Future refreshes will send `If-None-Match`.
		const newEtag = response.headers.get('etag') ?? undefined;
		const withMeta: ModelQuirksCatalog & CacheMeta = {
			...validated,
			__etag: newEtag,
			__fetchedAt: Date.now(),
		};
		fs.writeFileSync(cacheFilePath(userDataPath), JSON.stringify(withMeta, null, 2), 'utf-8');

		// Track freshness; respect the exe-adjacent pin (MAX priority — never swap it out).
		const fetchedDate = catalogDate(validated);
		_latestAvailableDate = maxDate(_latestAvailableDate, fetchedDate);
		if (_activeSource === 'exeAdjacent') {
			// exe override stays active; just re-evaluate whether it's now behind the CDN.
			_staleExeAdjacent = _latestAvailableDate !== '' && _activeDate < _latestAvailableDate;
		} else {
			// Not pinned — adopt the freshly fetched catalog (a CDN 200 is the newest source).
			_catalog = validated;
			_activeSource = 'cdn';
			_activeDate = fetchedDate;
		}
	} catch {
		// Network down / DNS / TLS / aggregator rate-limit — silent failure, keep
		// current catalog. NOTE: must NOT call console.warn/error here — Windows GUI
		// process has no stderr, and any console output triggers EPIPE → unhandled
		// rejection → main-process crash dialog (same root cause as v0.13.3 / pre-v0.13.7
		// crash with __dirname in ESM).
	}
}

function scheduleRefresh(intervalHours: number, url: string, userDataPath: string): void {
	if (_refreshTimer !== null) {
		clearTimeout(_refreshTimer);
		_refreshTimer = null;
	}
	if (intervalHours <= 0) { return; }  // manual-only
	const ms = intervalHours * 60 * 60 * 1000;
	const handle: ReturnType<typeof setTimeout> = setTimeout(async () => {
		const cache = readCache(userDataPath);
		await fetchFromCDN(url, userDataPath, cache.etag);
		scheduleRefresh(intervalHours, url, userDataPath);  // self-reschedule
	}, ms);
	// `setTimeout` is re-typed by VS Code as `TimeoutHandle` (no `.unref`), but the
	// native Electron-main handle DOES support it — feature-detect via a narrow cast.
	const unrefable = handle as unknown as { unref?: () => void };
	if (typeof unrefable.unref === 'function') { unrefable.unref(); }  // don't delay app.quit()
	_refreshTimer = handle;
}

/**
 * Initialize the service. Idempotent. Loads the highest-tier available catalog
 * synchronously, kicks off CDN refresh on the background.
 *
 * Must be called AFTER `app.setPath('userData', ...)` so paths resolve correctly.
 * Recommended call site: from `src/main.ts` after watchdog init.
 *
 * Idle Watchdog is in same boat; following that pattern.
 */
export async function initModelQuirksService(userDataPath: string): Promise<void> {
	if (_initStarted) { return; }
	_initStarted = true;
	_userDataPath = userDataPath;

	const cfg = readSettings(userDataPath);
	_userOverride = cfg.userOverride;

	// Source resolution (priority): exe-adjacent override (MAX) → newer of {CDN-cache, bundled} by `date`.
	const exe = readExeAdjacent();
	const cache = readCache(userDataPath);
	const bundled = await readBundled();
	const cdnDate = catalogDate(cache.catalog);
	const bundledDate = catalogDate(bundled);
	if (exe) {
		// User explicitly dropped a file next to the exe → wins regardless of date.
		_catalog = exe;
		_activeSource = 'exeAdjacent';
		_activeDate = catalogDate(exe);
		_latestAvailableDate = maxDate(cdnDate, bundledDate);
		_staleExeAdjacent = _latestAvailableDate !== '' && _activeDate < _latestAvailableDate;
	} else if (cache.catalog && (!bundled || cdnDate >= bundledDate)) {
		// CDN-cache present and at least as new as bundled.
		_catalog = cache.catalog;
		_activeSource = 'cdn';
		_activeDate = cdnDate;
		_latestAvailableDate = maxDate(cdnDate, bundledDate);
	} else if (bundled) {
		_catalog = bundled;
		_activeSource = 'bundled';
		_activeDate = bundledDate;
		_latestAvailableDate = maxDate(cdnDate, bundledDate);
	} else {
		// Last resort: cache exists but bundled failed to validate, else fully empty.
		_catalog = cache.catalog;
		_activeSource = cache.catalog ? 'cdn' : 'empty';
		_activeDate = cdnDate;
		_latestAvailableDate = cdnDate;
	}

	// Tier 1 (async): kick off CDN fetch immediately. Don't await — getQuirks() is
	// synchronous, callers use whatever's loaded now and pick up the fresh catalog
	// on next call after fetch completes.
	void fetchFromCDN(cfg.catalogUrl, userDataPath, cache.etag);
	scheduleRefresh(cfg.refreshIntervalHours, cfg.catalogUrl, userDataPath);
}

/**
 * Synchronous quirks lookup. Safe to call before `initModelQuirksService()` —
 * returns EMPTY_QUIRKS instead of throwing, and aiSdkAdapter degrades to
 * provider defaults gracefully.
 *
 * `providerName` enables per-provider matching in the catalog: rules with a
 * `provider` field only apply when their substring matches the given provider.
 * Without it (or with empty string), provider-scoped rules are skipped — callers
 * that don't track provider context fall through to unscoped rules.
 *
 * User override lookup also tries `${providerName}/${modelId}` first so users can
 * scope overrides per-route ("openCodeGo/qwen3.6-plus") in their settings.
 */
export function getModelQuirks(modelId: string, providerName?: string): ResolvedModelQuirks {
	if (!_catalog) { return EMPTY_QUIRKS; }
	const matched = matchQuirks(_catalog.rules, modelId, providerName);

	// User override lookup priority:
	//   1. `${providerName}/${modelId}` — most specific
	//   2. `${modelId}` exact — common case
	//   3. `${modelId}` lowercased — defensive for typos
	const providerKey = providerName ? `${providerName}/${modelId}` : '';
	const override =
		(providerKey && _userOverride[providerKey]) ??
		_userOverride[modelId] ??
		_userOverride[modelId.toLowerCase()];

	if (!matched && !override) { return EMPTY_QUIRKS; }
	return applyUserOverride(matched ?? EMPTY_QUIRKS, override);
}

/**
 * Catalog provenance + freshness snapshot — read by the renderer status contribution
 * to warn (once, at VibeIDE startup) when the exe-adjacent override is stale.
 */
export function getModelQuirksCatalogStatus(): ModelQuirksCatalogStatus {
	return {
		source: _activeSource,
		activeDate: _activeDate,
		latestAvailableDate: _latestAvailableDate,
		staleExeAdjacent: _staleExeAdjacent,
		exeAdjacentPath: _activeSource === 'exeAdjacent' ? exeAdjacentPath() : null,
	};
}

/**
 * Force a CDN refresh now. Returns true if catalog was updated, false otherwise
 * (304, network error, parse error). Exposed for the `vibeide.modelQuirks.refresh`
 * command — user can trigger refresh without waiting for the periodic schedule.
 */
export async function refreshModelQuirksCatalog(userDataPath: string): Promise<boolean> {
	const cfg = readSettings(userDataPath);
	const cache = readCache(userDataPath);
	const before = _catalog;
	await fetchFromCDN(cfg.catalogUrl, userDataPath, cache.etag);
	return _catalog !== before;
}

/** No-arg refresh using the userData path saved at init — for the status channel / command. */
export async function refreshModelQuirksCatalogNow(): Promise<boolean> {
	if (!_userDataPath) { return false; }
	return refreshModelQuirksCatalog(_userDataPath);
}

/**
 * Test-only — reset module state. Real callers should use `initModelQuirksService()`.
 */
export function __resetForTests(): void {
	_catalog = null;
	_userOverride = {};
	_initStarted = false;
	_userDataPath = '';
	_activeSource = 'empty';
	_activeDate = '';
	_latestAvailableDate = '';
	_staleExeAdjacent = false;
	if (_refreshTimer !== null) {
		clearTimeout(_refreshTimer);
		_refreshTimer = null;
	}
}
