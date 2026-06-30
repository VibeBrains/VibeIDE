/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * NLS bundle live-reload — hash diff helper
 * (roadmap §"i18n improvements — Live-reload bundle в dev: правка
 * `vibeide.nls.ru.json` без полного `compile-build` — watch-таск пересобирает
 * только nls-файлы, fileWatcher в `bootstrap-esm.ts` подхватывает").
 *
 * Pure helper — `vscode`-free. The dev watcher computes a content hash for
 * each NLS bundle file; this helper diffs the previous and current hash
 * maps and decides which UI parts need to refresh.
 *
 * `IFileService.watch` lives in the runtime adapter; the helper takes the
 * already-hashed snapshots as input.
 */

export interface NlsBundleSnapshot {
	readonly localeTag: string;
	/** map of `key → sha256-hex` for stable diffing. */
	readonly perKeyHash: ReadonlyMap<string, string>;
	/** Aggregate hash of the whole bundle — for fast no-op detection. */
	readonly bundleHash: string;
}

export type NlsReloadVerdict =
	| { readonly kind: 'no-op'; readonly reason: 'identical' | 'no-prior' }
	| { readonly kind: 'reload-keys'; readonly addedKeys: readonly string[]; readonly modifiedKeys: readonly string[]; readonly removedKeys: readonly string[] }
	| { readonly kind: 'full-reload'; readonly reason: 'locale-changed' | 'too-many-changes'; readonly changeCount?: number };

export interface NlsLiveReloadInput {
	readonly previous: NlsBundleSnapshot | null;
	readonly current: NlsBundleSnapshot;
	/** When per-key change count exceeds this, recommend a full reload. */
	readonly fullReloadThreshold?: number;
}

const DEFAULT_FULL_RELOAD_THRESHOLD = 50;

/**
 * Decide what dev clients should refresh after the watcher detected a
 * bundle change. Pure.
 *
 *   - no previous snapshot                    → 'no-op: no-prior'
 *   - bundleHash identical                    → 'no-op: identical'
 *   - localeTag changed                       → 'full-reload: locale-changed'
 *   - changes > threshold (default 50)        → 'full-reload: too-many-changes'
 *   - otherwise                               → 'reload-keys: {added, modified, removed}'
 */
export function decideNlsLiveReload(input: NlsLiveReloadInput): NlsReloadVerdict {
	if (input.previous === null) {
		return { kind: 'no-op', reason: 'no-prior' };
	}
	if (input.previous.bundleHash === input.current.bundleHash) {
		return { kind: 'no-op', reason: 'identical' };
	}
	if (normalise(input.previous.localeTag) !== normalise(input.current.localeTag)) {
		return { kind: 'full-reload', reason: 'locale-changed' };
	}
	const threshold = clampThreshold(input.fullReloadThreshold);

	const added: string[] = [];
	const modified: string[] = [];
	const removed: string[] = [];

	const prev = input.previous.perKeyHash;
	const curr = input.current.perKeyHash;

	for (const [k, prevHash] of prev) {
		const currHash = curr.get(k);
		if (currHash === undefined) {
			removed.push(k);
		} else if (currHash !== prevHash) {
			modified.push(k);
		}
	}
	for (const [k] of curr) {
		if (!prev.has(k)) {
			added.push(k);
		}
	}

	const total = added.length + modified.length + removed.length;
	if (total > threshold) {
		return { kind: 'full-reload', reason: 'too-many-changes', changeCount: total };
	}

	added.sort();
	modified.sort();
	removed.sort();
	return { kind: 'reload-keys', addedKeys: added, modifiedKeys: modified, removedKeys: removed };
}

function normalise(s: string): string {
	if (typeof s !== 'string') { return ''; }
	return s.trim().toLowerCase().replace(/_/g, '-');
}

function clampThreshold(raw: number | undefined): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) { return DEFAULT_FULL_RELOAD_THRESHOLD; }
	return Math.floor(raw);
}

/**
 * Pure: build a snapshot from a key→value map. Caller passes a hash
 * function (typically a fast hash like FNV-1a in dev; SHA-256 not required
 * since this is for local diff only). The aggregate `bundleHash` is the
 * hash of all per-key hashes concatenated — collision-resistant enough
 * for live-reload heuristics.
 */
export function buildNlsBundleSnapshot(
	localeTag: string,
	entries: ReadonlyMap<string, string>,
	hashFn: (s: string) => string,
): NlsBundleSnapshot {
	const perKeyHash = new Map<string, string>();
	const sortedKeys = [...entries.keys()].sort();
	let aggregate = '';
	for (const k of sortedKeys) {
		const valueHash = hashFn(entries.get(k)!);
		perKeyHash.set(k, valueHash);
		aggregate += `${k}:${valueHash}|`;
	}
	return {
		localeTag,
		perKeyHash,
		bundleHash: hashFn(aggregate),
	};
}

/**
 * Cheap FNV-1a 32-bit hash for dev use only — NOT a cryptographic
 * primitive. Caller decides the algorithm; this is exported as a
 * convenience for unit tests.
 */
export function fnv1a32(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

/**
 * Group reload keys by file/component prefix so the watcher can selectively
 * remount UI subtrees rather than the whole NLS bundle. Pure.
 *
 *   `vibeide.chat.send` + `vibeide.chat.cancel` → group `vibeide.chat.*`
 *   `vibeide.commands.run` → group `vibeide.commands.*`
 */
export function groupKeysByPrefix(
	keys: ReadonlyArray<string>,
	depth = 2,
): readonly { readonly prefix: string; readonly keys: readonly string[] }[] {
	const map = new Map<string, string[]>();
	for (const k of keys) {
		const parts = k.split('.');
		const head = parts.slice(0, depth).join('.');
		const arr = map.get(head);
		if (arr === undefined) { map.set(head, [k]); }
		else { arr.push(k); }
	}
	return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, keys]) => ({ prefix, keys }));
}
