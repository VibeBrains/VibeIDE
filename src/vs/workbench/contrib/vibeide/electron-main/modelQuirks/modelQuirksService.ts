/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

/**
 * ModelQuirksService — main-process catalog loader for model-behaviour quirks.
 *
 * Fallback chain (each tier shadows the next):
 *   1. CDN fetch result, written to `${userData}/model-quirks-cache.json` (most recent).
 *   2. userData cache from previous successful CDN fetch.
 *   3. Bundled `resources/model-quirks.json` shipped with the IDE.
 *   4. Empty catalog (no quirks; provider defaults everywhere).
 *
 * On top of the resolved catalog match, the user override from
 * `vibeide.modelQuirks` setting is merged per-field (user wins).
 *
 * Settings read ONCE at first `getQuirks()` call directly from
 * `${userData}/User/settings.json` — same pattern as `vibeIdleWatchdogService`,
 * no IPC channel. Restart-required to pick up settings changes (acceptable for
 * a diagnostic-grade feature; IPC live-reload can come later).
 */

import * as path from 'node:path'
import * as fs from 'original-fs'
import { parse as parseJsonc } from '../../../../../base/common/jsonc.js'
import {
	ModelQuirksCatalog,
	ResolvedModelQuirks,
	EMPTY_QUIRKS,
	applyUserOverride,
	matchQuirks,
	validateCatalog,
} from '../../common/modelQuirks/modelQuirksTypes.js'
import { BUNDLED_CATALOG } from '../../common/modelQuirks/bundledCatalog.js'

const DEFAULT_CDN_URL = 'https://raw.githubusercontent.com/VibeIDETeam/VibeIDE/main/resources/model-quirks.json'
const CACHE_FILENAME = 'model-quirks-cache.json'
const DEFAULT_REFRESH_INTERVAL_HOURS = 24

/** Fields persisted on top of the catalog JSON in userData cache (ignored at runtime). */
interface CacheMeta {
	__etag?: string
	__fetchedAt?: number  // epoch ms
}

let _catalog: ModelQuirksCatalog | null = null
let _userOverride: Record<string, unknown> = {}
let _initStarted = false
let _refreshTimer: ReturnType<typeof setTimeout> | null = null

interface ReadConfig {
	catalogUrl: string
	refreshIntervalHours: number
	userOverride: Record<string, unknown>
}

function readSettings(userDataPath: string): ReadConfig {
	const fallback: ReadConfig = {
		catalogUrl: DEFAULT_CDN_URL,
		refreshIntervalHours: DEFAULT_REFRESH_INTERVAL_HOURS,
		userOverride: {},
	}
	try {
		const settingsPath = path.join(userDataPath, 'User', 'settings.json')
		const raw = fs.readFileSync(settingsPath, 'utf-8')
		const parsed = parseJsonc(raw) as Record<string, unknown> | null
		if (!parsed || typeof parsed !== 'object') return fallback

		const url = parsed['vibeide.modelQuirks.catalogUrl']
		const interval = parsed['vibeide.modelQuirks.refreshIntervalHours']
		const override = parsed['vibeide.modelQuirks']

		return {
			catalogUrl: typeof url === 'string' && url.length > 0 ? url : DEFAULT_CDN_URL,
			refreshIntervalHours: clampInt(interval, 0, 168, DEFAULT_REFRESH_INTERVAL_HOURS),
			userOverride: override && typeof override === 'object' && !Array.isArray(override)
				? (override as Record<string, unknown>)
				: {},
		}
	} catch {
		return fallback
	}
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v)
	if (!Number.isFinite(n)) return fallback
	return Math.max(min, Math.min(max, Math.round(n)))
}

function cacheFilePath(userDataPath: string): string {
	return path.join(userDataPath, CACHE_FILENAME)
}

function readBundled(): ModelQuirksCatalog | null {
	// Bundled catalog ships as a TS constant `BUNDLED_CATALOG` (auto-generated mirror
	// of `resources/model-quirks.json`). We do NOT read from disk because the gulp
	// build doesn't copy that JSON into the packaged app, and there's no stdout/stderr
	// on Windows GUI to log file-not-found errors — any `console.warn` here would
	// EPIPE-crash the main process. The TS constant approach guarantees the fallback
	// is always available, and `resources/model-quirks.json` remains the source of
	// truth for the CDN endpoint (the JSON file is what `raw.githubusercontent.com`
	// serves to running IDEs).
	try {
		return validateCatalog(BUNDLED_CATALOG)
	} catch {
		// BUNDLED_CATALOG is a typed TS object that already passed compile — should
		// never throw, but defensively swallow if validateCatalog rejects a future
		// schema breaking change in the constant.
		return null
	}
}

function readCache(userDataPath: string): { catalog: ModelQuirksCatalog | null; etag: string | undefined } {
	try {
		const raw = fs.readFileSync(cacheFilePath(userDataPath), 'utf-8')
		const parsed = JSON.parse(raw) as Record<string, unknown> & CacheMeta
		const etag = typeof parsed.__etag === 'string' ? parsed.__etag : undefined
		return { catalog: validateCatalog(parsed), etag }
	} catch {
		return { catalog: null, etag: undefined }
	}
}

async function fetchFromCDN(url: string, userDataPath: string, currentEtag: string | undefined): Promise<void> {
	try {
		const headers: Record<string, string> = {
			'Accept': 'application/json',
			// Polite user-agent for raw.githubusercontent.com — GH sometimes throttles
			// generic UA strings; identify ourselves.
			'User-Agent': 'VibeIDE-ModelQuirks/1',
		}
		if (currentEtag) headers['If-None-Match'] = currentEtag

		const response = await fetch(url, { headers })
		if (response.status === 304) return                          // not modified — keep cached
		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)

		const text = await response.text()
		const parsed = JSON.parse(text)
		const validated = validateCatalog(parsed)

		// Persist with meta. Future refreshes will send `If-None-Match`.
		const newEtag = response.headers.get('etag') ?? undefined
		const withMeta: ModelQuirksCatalog & CacheMeta = {
			...validated,
			__etag: newEtag,
			__fetchedAt: Date.now(),
		}
		fs.writeFileSync(cacheFilePath(userDataPath), JSON.stringify(withMeta, null, 2), 'utf-8')

		// Atomic swap.
		_catalog = validated
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
		clearTimeout(_refreshTimer)
		_refreshTimer = null
	}
	if (intervalHours <= 0) return  // manual-only
	const ms = intervalHours * 60 * 60 * 1000
	const handle: any = setTimeout(async () => {
		const cache = readCache(userDataPath)
		await fetchFromCDN(url, userDataPath, cache.etag)
		scheduleRefresh(intervalHours, url, userDataPath)  // self-reschedule
	}, ms)
	if (typeof handle?.unref === 'function') handle.unref()  // don't delay app.quit()
	_refreshTimer = handle
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
export function initModelQuirksService(userDataPath: string): void {
	if (_initStarted) return
	_initStarted = true

	const cfg = readSettings(userDataPath)
	_userOverride = cfg.userOverride

	// Tier 2: userData cache from previous CDN fetch.
	const cache = readCache(userDataPath)
	if (cache.catalog) {
		_catalog = cache.catalog
	} else {
		// Tier 3: bundled catalog shipped with this IDE build.
		_catalog = readBundled()
	}
	// Tier 4: empty (handled lazily by getQuirks if _catalog stays null).

	// Tier 1 (async): kick off CDN fetch immediately. Don't await — getQuirks() is
	// synchronous, callers use whatever's loaded now and pick up the fresh catalog
	// on next call after fetch completes.
	void fetchFromCDN(cfg.catalogUrl, userDataPath, cache.etag)
	scheduleRefresh(cfg.refreshIntervalHours, cfg.catalogUrl, userDataPath)
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
 * scope overrides per-route ("openCode/qwen3.6-plus") in their settings.
 */
export function getModelQuirks(modelId: string, providerName?: string): ResolvedModelQuirks {
	if (!_catalog) return EMPTY_QUIRKS
	const matched = matchQuirks(_catalog.rules, modelId, providerName)

	// User override lookup priority:
	//   1. `${providerName}/${modelId}` — most specific
	//   2. `${modelId}` exact — common case
	//   3. `${modelId}` lowercased — defensive for typos
	const providerKey = providerName ? `${providerName}/${modelId}` : ''
	const override =
		(providerKey && _userOverride[providerKey]) ??
		_userOverride[modelId] ??
		_userOverride[modelId.toLowerCase()]

	if (!matched && !override) return EMPTY_QUIRKS
	return applyUserOverride(matched ?? EMPTY_QUIRKS, override)
}

/**
 * Force a CDN refresh now. Returns true if catalog was updated, false otherwise
 * (304, network error, parse error). Exposed for the `vibeide.modelQuirks.refresh`
 * command — user can trigger refresh without waiting for the periodic schedule.
 */
export async function refreshModelQuirksCatalog(userDataPath: string): Promise<boolean> {
	const cfg = readSettings(userDataPath)
	const cache = readCache(userDataPath)
	const before = _catalog
	await fetchFromCDN(cfg.catalogUrl, userDataPath, cache.etag)
	return _catalog !== before
}

/**
 * Test-only — reset module state. Real callers should use `initModelQuirksService()`.
 */
export function __resetForTests(): void {
	_catalog = null
	_userOverride = {}
	_initStarted = false
	if (_refreshTimer !== null) {
		clearTimeout(_refreshTimer)
		_refreshTimer = null
	}
}
