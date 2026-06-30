/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Session memory per chat thread (K.3 / 934) — short-term brain.
 *
 * Distinct from `vibeMemoryDecayService.ts` (long-term Project Brain → `.vibe/context.md`):
 *   - lives only in IDE storage, never on disk in `.vibe/`
 *   - scoped to a single `threadId`, dies with the thread (on close or 7-day TTL)
 *   - intended use: agent's "what did I just decide one turn ago" recall, no cloud
 *
 * This module is the **pure shape + decay helper**. The DI wrapper that hooks it
 * up to `IStorageService` and the chat thread lifecycle is a follow-up — see the
 * skeleton-acceptable section in the roadmap.
 */

export type SessionMemoryKind = 'decision' | 'observation' | 'instruction' | 'todo';

export interface SessionMemoryEntry {
	id: string;
	threadId: string;
	createdAt: number; // unix ms
	updatedAt: number; // unix ms — touched on access, used as decay anchor
	kind: SessionMemoryKind;
	content: string;
}

export interface SessionMemoryStore {
	/** Schema version — increment when the on-disk shape changes. */
	v: 1;
	/** Per-threadId chronological list. */
	byThread: Record<string, SessionMemoryEntry[]>;
}

export const SESSION_MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_MEMORY_MAX_PER_THREAD = 50;
export const SESSION_MEMORY_MAX_CONTENT_CHARS = 2_000;

/** Empty store factory. */
export function createEmptySessionMemoryStore(): SessionMemoryStore {
	return { v: 1, byThread: {} };
}

/**
 * Strict envelope decoder. Returns a tagged result instead of throwing on a
 * malformed `unknown` (typical for storage that survived a schema change).
 */
export function decodeSessionMemoryStore(raw: unknown): { ok: true; value: SessionMemoryStore } | { ok: false; reason: string } {
	if (raw === null || raw === undefined || typeof raw !== 'object') {
		return { ok: false, reason: 'not-an-object' };
	}
	const obj = raw as Record<string, unknown>;
	if (obj.v !== 1) {
		return { ok: false, reason: `unsupported-version:${String(obj.v)}` };
	}
	if (obj.byThread === null || obj.byThread === undefined || typeof obj.byThread !== 'object') {
		return { ok: false, reason: 'byThread-missing' };
	}
	const byThread: Record<string, SessionMemoryEntry[]> = {};
	for (const [tid, list] of Object.entries(obj.byThread as Record<string, unknown>)) {
		if (!Array.isArray(list)) {
			return { ok: false, reason: `byThread.${tid}-not-array` };
		}
		const entries: SessionMemoryEntry[] = [];
		for (const item of list) {
			if (!isValidEntry(item)) {
				return { ok: false, reason: `byThread.${tid}-bad-entry` };
			}
			entries.push(item);
		}
		byThread[tid] = entries;
	}
	return { ok: true, value: { v: 1, byThread } };
}

function isValidEntry(item: unknown): item is SessionMemoryEntry {
	if (item === null || item === undefined || typeof item !== 'object') { return false; }
	const e = item as Record<string, unknown>;
	return typeof e.id === 'string'
		&& typeof e.threadId === 'string'
		&& typeof e.createdAt === 'number'
		&& typeof e.updatedAt === 'number'
		&& (e.kind === 'decision' || e.kind === 'observation' || e.kind === 'instruction' || e.kind === 'todo')
		&& typeof e.content === 'string';
}

/**
 * Append a new entry. Truncates content, enforces per-thread cap (drops oldest by
 * `updatedAt`). Returns a NEW store object — pure, no mutation of the input.
 */
export function appendSessionMemory(
	store: SessionMemoryStore,
	entry: Omit<SessionMemoryEntry, 'createdAt' | 'updatedAt'>,
	now: number,
): SessionMemoryStore {
	const trimmed = entry.content.length > SESSION_MEMORY_MAX_CONTENT_CHARS
		? entry.content.slice(0, SESSION_MEMORY_MAX_CONTENT_CHARS)
		: entry.content;
	const newEntry: SessionMemoryEntry = {
		...entry,
		content: trimmed,
		createdAt: now,
		updatedAt: now,
	};
	const list = store.byThread[entry.threadId] ?? [];
	const next = [...list, newEntry];
	if (next.length > SESSION_MEMORY_MAX_PER_THREAD) {
		// Drop oldest by updatedAt (keep most-recently-touched entries).
		next.sort((a, b) => a.updatedAt - b.updatedAt);
		next.splice(0, next.length - SESSION_MEMORY_MAX_PER_THREAD);
	}
	return {
		v: 1,
		byThread: { ...store.byThread, [entry.threadId]: next },
	};
}

/**
 * Mark a memory as touched (recall hit). Pure — returns a NEW store, leaves
 * everything else untouched.
 */
export function touchSessionMemory(
	store: SessionMemoryStore,
	threadId: string,
	entryId: string,
	now: number,
): SessionMemoryStore {
	const list = store.byThread[threadId];
	if (!list) { return store; }
	const next = list.map(e => e.id === entryId ? { ...e, updatedAt: now } : e);
	return { v: 1, byThread: { ...store.byThread, [threadId]: next } };
}

/**
 * Drop entries past the TTL (anchored on `updatedAt`) and any entries belonging
 * to closed threads. Pure — returns a NEW store.
 *
 * `closedThreadIds` is the set of thread ids the caller knows are gone (e.g.
 * after `closeThread`); their memories are removed regardless of TTL.
 */
export function decaySessionMemory(
	store: SessionMemoryStore,
	now: number,
	closedThreadIds: ReadonlySet<string> = new Set(),
	ttlMs: number = SESSION_MEMORY_TTL_MS,
): SessionMemoryStore {
	const cutoff = now - ttlMs;
	const next: Record<string, SessionMemoryEntry[]> = {};
	for (const [tid, list] of Object.entries(store.byThread)) {
		if (closedThreadIds.has(tid)) {
			continue;
		}
		const survived = list.filter(e => e.updatedAt >= cutoff);
		if (survived.length > 0) {
			next[tid] = survived;
		}
	}
	return { v: 1, byThread: next };
}

/**
 * Lookup the N most-recently-touched entries for a thread, optionally filtered
 * by kind. Pure read — does not touch `updatedAt` (caller invokes
 * `touchSessionMemory` if a hit should keep the entry alive).
 */
export function getRecentSessionMemories(
	store: SessionMemoryStore,
	threadId: string,
	limit: number,
	kind?: SessionMemoryKind,
): SessionMemoryEntry[] {
	const list = store.byThread[threadId] ?? [];
	const filtered = kind ? list.filter(e => e.kind === kind) : list;
	return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
