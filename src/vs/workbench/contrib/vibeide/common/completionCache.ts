/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure LRU cache for tab-completion / FIM (L.3 / 1019).
 *
 * Suggestions are keyed by `${fileUri}:${line}:${col}:${prefixHash}` and
 * invalidated by an `invalidateForUri` call when the file is edited.
 * Time injection (`now: number`) keeps the unit tests deterministic.
 *
 * vscode-free: no imports beyond standard lib.
 */

export interface CompletionCacheEntry<T> {
	value: T;
	createdAt: number;
	lastAccessedAt: number;
	hits: number;
}

export interface CompletionCacheStats {
	size: number;
	hits: number;
	misses: number;
	evictions: number;
	invalidations: number;
}

export interface CompletionCacheOptions {
	/** Hard cap on entries before LRU eviction kicks in. Default 256. */
	maxEntries?: number;
	/** TTL for an entry; older entries become misses. Default 5 minutes. */
	ttlMs?: number;
}

const DEFAULTS = {
	maxEntries: 256,
	ttlMs: 5 * 60 * 1000,
};

/**
 * Compose the cache key. The prefix hash is left to the caller — the cache
 * does not interpret it. Cursor coordinates are 1-based (Monaco convention).
 */
export function makeCompletionCacheKey(uri: string, line: number, column: number, prefixHash: string): string {
	return `${uri}\x00${line}\x00${column}\x00${prefixHash}`;
}

/**
 * Stable hash for the prefix string used in the cache key. Tiny FNV-1a so
 * two prefixes that differ by a single character don't share a key. Pure.
 */
export function hashCompletionPrefix(prefix: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < prefix.length; i++) {
		h ^= prefix.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * Pure LRU cache. Insertion bumps the entry to "most recent"; on cap overflow
 * the least-recently-used entry is dropped. All API takes `now` as input — no
 * Date.now() inside the module.
 */
export class CompletionCache<T> {
	private readonly _map = new Map<string, CompletionCacheEntry<T>>();
	private readonly _max: number;
	private readonly _ttl: number;
	private _stats: CompletionCacheStats = { size: 0, hits: 0, misses: 0, evictions: 0, invalidations: 0 };

	constructor(options: CompletionCacheOptions = {}) {
		this._max = options.maxEntries ?? DEFAULTS.maxEntries;
		this._ttl = options.ttlMs ?? DEFAULTS.ttlMs;
	}

	/** Insert or refresh an entry. */
	set(key: string, value: T, now: number): void {
		// Remove + re-insert so Map ordering reflects recency.
		if (this._map.has(key)) {
			this._map.delete(key);
		}
		this._map.set(key, { value, createdAt: now, lastAccessedAt: now, hits: 0 });
		while (this._map.size > this._max) {
			const oldest = this._map.keys().next().value;
			if (oldest === undefined) { break; }
			this._map.delete(oldest);
			this._stats.evictions++;
		}
		this._stats.size = this._map.size;
	}

	/** Lookup. Returns `undefined` on miss or expired entry. */
	get(key: string, now: number): T | undefined {
		const entry = this._map.get(key);
		if (!entry) {
			this._stats.misses++;
			return undefined;
		}
		if (now - entry.createdAt > this._ttl) {
			this._map.delete(key);
			this._stats.misses++;
			this._stats.size = this._map.size;
			return undefined;
		}
		// Bump recency.
		this._map.delete(key);
		entry.lastAccessedAt = now;
		entry.hits++;
		this._map.set(key, entry);
		this._stats.hits++;
		return entry.value;
	}

	/** Drop every entry whose key starts with `${uri}\x00`. Call on file edit. */
	invalidateForUri(uri: string): number {
		const prefix = `${uri}\x00`;
		let dropped = 0;
		for (const key of this._map.keys()) {
			if (key.startsWith(prefix)) {
				this._map.delete(key);
				dropped++;
			}
		}
		if (dropped > 0) {
			this._stats.invalidations += dropped;
			this._stats.size = this._map.size;
		}
		return dropped;
	}

	/** Drop everything. */
	clear(): void {
		this._stats.invalidations += this._map.size;
		this._map.clear();
		this._stats.size = 0;
	}

	stats(): CompletionCacheStats {
		return { ...this._stats };
	}

	/** Test hook. */
	debugSize(): number {
		return this._map.size;
	}
}
