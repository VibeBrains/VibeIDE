/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Session memory per chat thread — DI wrapper around the pure helper
 * `sessionMemoryPerThread.ts` (roadmap §K.3 / 933).
 *
 * Persists the per-thread short-term brain in `IStorageService` under
 * `WORKSPACE` scope, so memories survive window reload but never leak between
 * unrelated workspaces. TTL decay (default 7 days) runs once at construction;
 * thread-disposal cleanup is exposed as a manual `releaseThread` API —
 * skeleton-acceptable per the roadmap entry until `IChatThreadService` ships
 * an `onDidDisposeThread` event we can subscribe to.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	SessionMemoryEntry,
	SessionMemoryKind,
	SessionMemoryStore,
	SESSION_MEMORY_TTL_MS,
	appendSessionMemory,
	createEmptySessionMemoryStore,
	decaySessionMemory,
	decodeSessionMemoryStore,
	getRecentSessionMemories,
	touchSessionMemory,
} from './sessionMemoryPerThread.js';

const STORAGE_KEY = 'vibeide.sessionMemory.v1';

export interface AppendInput {
	readonly threadId: string;
	readonly kind: SessionMemoryKind;
	readonly content: string;
}

export const IVibeSessionMemoryService = createDecorator<IVibeSessionMemoryService>('vibeSessionMemoryService');

export interface IVibeSessionMemoryService {
	readonly _serviceBrand: undefined;

	/**
	 * Append a new memory entry. Generates a fresh `id` via `generateUuid`,
	 * delegates content-cap and per-thread-cap to the pure helper, persists.
	 */
	append(input: AppendInput): SessionMemoryEntry;

	/** Touch an entry's `updatedAt` (recall hit). No-op if entry not found. Persists on hit. */
	touch(threadId: string, entryId: string): void;

	/** N most-recently-touched entries for the thread, optionally filtered by kind. Read-only. */
	getRecent(threadId: string, limit: number, kind?: SessionMemoryKind): SessionMemoryEntry[];

	/**
	 * Drop all entries for a thread (called manually when the thread is closed —
	 * auto-binding to a chat-thread disposal event is a follow-up). Persists.
	 */
	releaseThread(threadId: string): void;
}

class VibeSessionMemoryService extends Disposable implements IVibeSessionMemoryService {
	declare readonly _serviceBrand: undefined;

	private _memory: SessionMemoryStore;

	constructor(
		@IStorageService private readonly _storage: IStorageService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._memory = this._loadStore();

		// One-shot TTL decay so reopened windows do not resurface stale memories.
		const now = Date.now();
		const decayed = decaySessionMemory(this._memory, now, new Set(), SESSION_MEMORY_TTL_MS);
		if (this._snapshotChanged(this._memory, decayed)) {
			this._memory = decayed;
			this._persist();
		}
	}

	append(input: AppendInput): SessionMemoryEntry {
		const id = generateUuid();
		const now = Date.now();
		this._memory = appendSessionMemory(this._memory, {
			id,
			threadId: input.threadId,
			kind: input.kind,
			content: input.content,
		}, now);
		this._persist();
		// The helper trims content and may have evicted older entries; re-read
		// from the new store rather than constructing the result locally.
		const list = this._memory.byThread[input.threadId] ?? [];
		const created = list.find(e => e.id === id);
		if (!created) {
			// Should never happen — append always retains the new entry above the
			// per-thread cap, but if eviction logic ever changes we fail loudly.
			throw new Error('VibeSessionMemoryService.append: created entry missing after persist');
		}
		return created;
	}

	touch(threadId: string, entryId: string): void {
		const list = this._memory.byThread[threadId] ?? [];
		const target = list.find(e => e.id === entryId);
		if (!target) {
			return;
		}
		const now = Date.now();
		this._memory = touchSessionMemory(this._memory, threadId, entryId, now);
		this._persist();
	}

	getRecent(threadId: string, limit: number, kind?: SessionMemoryKind): SessionMemoryEntry[] {
		return getRecentSessionMemories(this._memory, threadId, limit, kind);
	}

	releaseThread(threadId: string): void {
		if (!Object.hasOwn(this._memory.byThread, threadId)) {
			return;
		}
		const next: SessionMemoryStore = {
			v: 1,
			byThread: { ...this._memory.byThread },
		};
		delete next.byThread[threadId];
		this._memory = next;
		this._persist();
	}

	private _loadStore(): SessionMemoryStore {
		const raw = this._storage.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) {
			return createEmptySessionMemoryStore();
		}
		try {
			const parsed = JSON.parse(raw);
			const decoded = decodeSessionMemoryStore(parsed);
			if (decoded.ok) {
				return decoded.value;
			}
			this._log.info(`[VibeSessionMemory] storage decode failed (${decoded.reason}); resetting to empty.`);
		} catch (e) {
			this._log.info('[VibeSessionMemory] storage JSON parse failed; resetting to empty.', e);
		}
		return createEmptySessionMemoryStore();
	}

	private _persist(): void {
		try {
			const serialised = JSON.stringify(this._memory);
			this._storage.store(STORAGE_KEY, serialised, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch (e) {
			this._log.warn('[VibeSessionMemory] persist failed', e);
		}
	}

	/**
	 * Cheap structural equality on the byThread map — both stores are pure values
	 * built by the helper, so reference inequality only happens when something
	 * actually changed. We still verify the threadIds set to be safe.
	 */
	private _snapshotChanged(a: SessionMemoryStore, b: SessionMemoryStore): boolean {
		if (a === b) {
			return false;
		}
		const ak = Object.keys(a.byThread);
		const bk = Object.keys(b.byThread);
		if (ak.length !== bk.length) {
			return true;
		}
		for (const k of ak) {
			if ((a.byThread[k] ?? []).length !== (b.byThread[k] ?? []).length) {
				return true;
			}
		}
		return false;
	}
}

registerSingleton(IVibeSessionMemoryService, VibeSessionMemoryService, InstantiationType.Delayed);
