/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Workspace bookmark registry for Vibe Projects (native workbench feature, MIT).
 * Persistence: JSON under the user profile global storage path.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';

export const IVibeProjectsService = createDecorator<IVibeProjectsService>('vibeProjectsService');

export interface IVibeProjectsEntry {
	readonly id: string;
	readonly label: string;
	readonly target: URI;
}

export interface IVibeProjectsService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeEntries: Event<void>;
	readEntries(): Promise<readonly IVibeProjectsEntry[]>;
	enqueuePersist(entry: IVibeProjectsEntry): Promise<void>;
	dropEntry(id: string): Promise<void>;
	replaceAll(entries: IVibeProjectsEntry[]): Promise<void>;
	resolveCatalogUri(): URI;
	/** Creates catalog.json (and parents) when missing; inexpensive if it already exists. */
	ensureCatalogOnDisk(): Promise<URI>;
}

interface PersistedShard {
	readonly schema: 'vibe-projects.v1';
	readonly seeds: ReadonlyArray<{ readonly id: string; readonly label: string; readonly target: string }>;
}

class VibeProjectsService extends Disposable implements IVibeProjectsService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeEntries = this._register(new Emitter<void>());
	readonly onDidChangeEntries = this._onDidChangeEntries.event;

	private _snapshot: IVibeProjectsEntry[] = [];
	private _hydrateOnce: Promise<void> | undefined;

	constructor(
		@IFileService private readonly _files: IFileService,
		@IUserDataProfilesService private readonly _profiles: IUserDataProfilesService,
		@IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
	}

	private _catalogUri(): URI {
		const vault = joinPath(this._profiles.defaultProfile.globalStorageHome, 'vibeide', 'workspace-bookmarks');
		return joinPath(vault, 'catalog.json');
	}

	resolveCatalogUri(): URI {
		return this._catalogUri();
	}

	async ensureCatalogOnDisk(): Promise<URI> {
		await this._ensureHydrated();
		const uri = this._catalogUri();
		if (!(await this._files.exists(uri))) {
			await this._flush();
		}
		return uri;
	}

	private async _ensureHydrated(): Promise<void> {
		if (!this._hydrateOnce) {
			this._hydrateOnce = this._pullFromDisk();
		}
		await this._hydrateOnce;
	}

	private async _pullFromDisk(): Promise<void> {
		const uri = this._catalogUri();
		try {
			await this._files.resolve(uri);
		} catch {
			this._snapshot = [];
			return;
		}
		try {
			const raw = (await this._files.readFile(uri)).value.toString();
			const parsed = JSON.parse(raw) as PersistedShard;
			if (!parsed || parsed.schema !== 'vibe-projects.v1' || !Array.isArray(parsed.seeds)) {
				this._log.warn('[VibeProjects] Catalog schema mismatch — starting empty.');
				this._snapshot = [];
				return;
			}
			const next: IVibeProjectsEntry[] = [];
			for (const row of parsed.seeds) {
				if (!row?.id || !row.label || !row.target) {
					continue;
				}
				let target: URI;
				try {
					target = URI.parse(row.target);
				} catch {
					continue;
				}
				next.push({ id: row.id, label: row.label, target });
			}
			this._snapshot = next;
		} catch (e) {
			this._log.error('[VibeProjects] Failed to read catalog', e);
			this._snapshot = [];
		}
	}

	private async _flush(): Promise<void> {
		const uri = this._catalogUri();
		const parent = this._uriIdentity.extUri.dirname(uri);
		if (!(await this._files.exists(parent))) {
			await this._files.createFolder(parent);
		}
		const body: PersistedShard = {
			schema: 'vibe-projects.v1',
			seeds: this._snapshot.map(s => ({ id: s.id, label: s.label, target: s.target.toString(true) })),
		};
		await this._files.writeFile(uri, VSBuffer.fromString(JSON.stringify(body, undefined, '\t')));
	}

	async readEntries(): Promise<readonly IVibeProjectsEntry[]> {
		await this._ensureHydrated();
		return [...this._snapshot];
	}

	async enqueuePersist(entry: IVibeProjectsEntry): Promise<void> {
		await this._ensureHydrated();
		const deduped = this._snapshot.filter(
			e => e.id !== entry.id && !this._uriIdentity.extUri.isEqual(e.target, entry.target)
		);
		this._snapshot = [...deduped, entry];
		await this._flush();
		this._onDidChangeEntries.fire();
	}

	async dropEntry(id: string): Promise<void> {
		await this._ensureHydrated();
		const before = this._snapshot.length;
		this._snapshot = this._snapshot.filter(e => e.id !== id);
		if (this._snapshot.length !== before) {
			await this._flush();
			this._onDidChangeEntries.fire();
		}
	}

	async replaceAll(entries: IVibeProjectsEntry[]): Promise<void> {
		await this._ensureHydrated();
		this._snapshot = [...entries];
		await this._flush();
		this._onDidChangeEntries.fire();
	}
}

registerSingleton(IVibeProjectsService, VibeProjectsService, InstantiationType.Delayed);
