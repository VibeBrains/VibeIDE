/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { relative } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { match as globMatch } from '../../../../base/common/glob.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { decodeAgentLocks, filterLocksForDisposal } from '../common/agentLockDisposal.js';

/** Conflicting advisory territorial locks for a candidate write path */
export interface IAgentTerritorialLockConflict {
	readonly holders: string[];
	readonly patterns: string[];
}

export interface IVibeAgentTerritorialLockService {
	readonly _serviceBrand: undefined;
	/** Returns conflict info if `.vibe/agent-locks.json` has a matching non-expired lock; otherwise undefined */
	evaluateWrite(uri: URI): Promise<IAgentTerritorialLockConflict | undefined>;
	/**
	 * Release all locks whose `holder` matches `holderId` (exact string match).
	 * Called from `chatThreadService.deleteThread` with the threadId as holder key.
	 * No-op when the file is absent, non-canonical, or the holder has no entries.
	 */
	releaseHolderLocks(holderId: string): Promise<void>;
}

export const IVibeAgentTerritorialLockService = createDecorator<IVibeAgentTerritorialLockService>('vibeAgentTerritorialLockService');

type LockEntry = { holder?: unknown; paths?: unknown; until?: unknown };

export class VibeAgentTerritorialLockService extends Disposable implements IVibeAgentTerritorialLockService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
	) {
		super();
		// Fire-and-forget: never block service activation on a locks-file scan.
		void this._cleanupStaleLocks();

		// Cross-window holder cleanup needs a session-id we don't track here yet — see
		// roadmap §"agent-locks dispose" for the full per-thread hookup. For now we
		// only run startup TTL cleanup; this listener stays as a registration hook so
		// future revisions can release "ours" without reshuffling lifecycle.
		this._register(this._lifecycleService.onWillShutdown(() => {
			// no-op: see comment above
		}));
	}

	async evaluateWrite(uri: URI): Promise<IAgentTerritorialLockConflict | undefined> {
		const folder = this._workspaceContextService.getWorkspaceFolder(uri);
		if (!folder) {
			return undefined;
		}
		const locksUri = joinPath(folder.uri, '.vibe', 'agent-locks.json');
		let raw: string;
		try {
			const buf = await this._fileService.readFile(locksUri);
			raw = buf.value.toString();
		} catch {
			return undefined;
		}
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch (e) {
			vibeLog.warn('vibeAgentTerritorialLock', 'agent-locks.json: invalid JSON', e);
			return undefined;
		}

		const entries = this._normalizeEntries(data);
		const now = Date.now();
		const rel = relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
		if (!rel || rel.startsWith('..')) {
			return undefined;
		}

		const holders: string[] = [];
		const patterns: string[] = [];
		const holderSet = new Set<string>();
		const patternSet = new Set<string>();

		for (const e of entries) {
			if (!this._entryActive(e, now)) {
				continue;
			}
			const paths = Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === 'string' && !!p.trim()) : [];
			const holderLabel = typeof e.holder === 'string' && e.holder.trim() ? e.holder.trim() : '(unknown-holder)';
			for (const pattern of paths) {
				if (globMatch(pattern, rel)) {
					if (!holderSet.has(holderLabel)) {
						holderSet.add(holderLabel);
						holders.push(holderLabel);
					}
					if (!patternSet.has(pattern)) {
						patternSet.add(pattern);
						patterns.push(pattern);
					}
				}
			}
		}
		if (!holders.length) {
			return undefined;
		}
		return { holders, patterns };
	}

	private _normalizeEntries(data: unknown): LockEntry[] {
		if (Array.isArray(data)) {
			return data.filter((x): x is LockEntry => !!x && typeof x === 'object');
		}
		if (data && typeof data === 'object') {
			const locks = (data as { locks?: unknown }).locks;
			if (Array.isArray(locks)) {
				return locks.filter((x): x is LockEntry => !!x && typeof x === 'object');
			}
			if ((data as LockEntry).holder !== undefined || (data as LockEntry).paths !== undefined || (data as LockEntry).until !== undefined) {
				return [data as LockEntry];
			}
		}
		return [];
	}

	private _entryActive(e: LockEntry, nowMs: number): boolean {
		const u = e.until;
		if (u === undefined || u === null) {
			return true;
		}
		const t = Date.parse(String(u));
		if (!Number.isFinite(t)) {
			return false;
		}
		return t >= nowMs;
	}

	/**
	 * One-shot cleanup of TTL-expired locks at service init. Releases entries whose
	 * `until` is in the past; never touches non-expired locks (those need a separate
	 * holder-based release path — see roadmap §"agent-locks dispose").
	 *
	 * Skips silently when the file is absent, has the legacy `{ locks: [...] }` /
	 * single-object shape (helper expects the canonical flat array), or is malformed.
	 */
	private async _cleanupStaleLocks(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}
		const locksUri = joinPath(folders[0].uri, '.vibe', 'agent-locks.json');
		let raw: string;
		try {
			const buf = await this._fileService.readFile(locksUri);
			raw = buf.value.toString();
		} catch {
			return;
		}
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch (e) {
			vibeLog.warn('vibeAgentTerritorialLock', 'agent-locks.json: invalid JSON, skip TTL cleanup', e);
			return;
		}
		const decoded = decodeAgentLocks(data);
		if (decoded === null) {
			// Legacy `{ locks: [...] }` or single-object — not the canonical helper shape.
			// Don't risk rewriting; surface so the user can normalise via `vibe doctor`.
			vibeLog.warn('vibeAgentTerritorialLock', 'agent-locks.json: non-canonical shape, skip TTL cleanup');
			return;
		}
		const result = filterLocksForDisposal({
			locks: decoded,
			disposedHolders: new Set<string>(),
			now: Date.now(),
		});
		if (result.release.length === 0) {
			return;
		}
		for (const r of result.release) {
			vibeLog.info('vibeAgentTerritorialLock', `agent-lock released (${r.reason}): holder=${r.entry.holder} paths=${r.entry.paths.join(',')}`);
		}
		try {
			await this._fileService.writeFile(
				locksUri,
				VSBuffer.fromString(JSON.stringify(result.keep, null, 2) + '\n'),
				{ atomic: { postfix: '.vibe-tmp' } },
			);
		} catch (e) {
			vibeLog.warn('vibeAgentTerritorialLock', 'agent-locks.json: TTL cleanup write failed', e);
		}
	}

	async releaseHolderLocks(holderId: string): Promise<void> {
		if (!holderId) {
			return;
		}
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}
		const locksUri = joinPath(folders[0].uri, '.vibe', 'agent-locks.json');
		let raw: string;
		try {
			const buf = await this._fileService.readFile(locksUri);
			raw = buf.value.toString();
		} catch {
			return;
		}
		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			return;
		}
		const decoded = decodeAgentLocks(data);
		if (decoded === null) {
			return;
		}
		const result = filterLocksForDisposal({
			locks: decoded,
			disposedHolders: new Set([holderId]),
			now: Date.now(),
		});
		if (result.release.length === 0) {
			return;
		}
		for (const r of result.release) {
			vibeLog.info('vibeAgentTerritorialLock', `agent-lock holder-disposed (${r.reason}): holder=${r.entry.holder}`);
		}
		try {
			await this._fileService.writeFile(
				locksUri,
				VSBuffer.fromString(JSON.stringify(result.keep, null, 2) + '\n'),
				{ atomic: { postfix: '.vibe-tmp' } },
			);
		} catch (e) {
			vibeLog.warn('vibeAgentTerritorialLock', 'agent-locks.json: holder release write failed', e);
		}
	}
}

registerSingleton(IVibeAgentTerritorialLockService, VibeAgentTerritorialLockService, InstantiationType.Delayed);
