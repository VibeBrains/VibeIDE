/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { relative } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { match as globMatch } from '../../../../base/common/glob.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';

/** Conflicting advisory territorial locks for a candidate write path */
export interface IAgentTerritorialLockConflict {
	readonly holders: string[];
	readonly patterns: string[];
}

export interface IVibeAgentTerritorialLockService {
	readonly _serviceBrand: undefined;
	/** Returns conflict info if `.vibe/agent-locks.json` has a matching non-expired lock; otherwise undefined */
	evaluateWrite(uri: URI): Promise<IAgentTerritorialLockConflict | undefined>;
}

export const IVibeAgentTerritorialLockService = createDecorator<IVibeAgentTerritorialLockService>('vibeAgentTerritorialLockService');

type LockEntry = { holder?: unknown; paths?: unknown; until?: unknown };

export class VibeAgentTerritorialLockService implements IVibeAgentTerritorialLockService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
	) { }

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
			this._logService.warn('[VibeIDE] agent-locks.json: invalid JSON', e);
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
}

registerSingleton(IVibeAgentTerritorialLockService, VibeAgentTerritorialLockService, InstantiationType.Delayed);
