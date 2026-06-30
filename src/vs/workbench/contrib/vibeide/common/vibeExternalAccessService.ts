/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import { dirname } from '../../../../base/common/resources.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVibeModalService } from './vibeModalService.js';

/** Variant B — thrown by the sync URI validator when a tool targets a path outside the
 *  workspace that the user hasn't authorized. The tool-dispatch layer catches it, prompts
 *  (async), and on approval re-validates. Fail-closed: an uncaught instance denies access. */
export class ExternalAccessRequiredError extends Error {
	constructor(readonly uri: URI, readonly accessKind: 'read' | 'write') {
		super(`External access requires authorization: ${uri.fsPath}`);
		this.name = 'ExternalAccessRequiredError';
	}
}

/** Per-folder allowlist for agent file access outside the open workspace (O.13, Variant A).
 *  Granular replacement-companion for the binary `allowReadOutsideWorkspace` toggle: the user
 *  pre-authorizes specific folders (session or persisted-per-workspace) instead of opening
 *  read access globally. */
export const PERSISTED_ALLOWLIST_KEY = 'vibeide.agent.externalAccessAllowlist';

// ── Pure core (testable, no DI) ────────────────────────────────────────────────

/** Normalize a folder path for allowlist comparison: `\`→`/`, drop trailing slash,
 *  lowercase only on case-insensitive (Windows) filesystems. */
export const normalizeFolderPath = (p: string, caseSensitive: boolean): string => {
	const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
	return caseSensitive ? s : s.toLowerCase();
};

/** True when `targetPath` is inside (or equal to) any allowed folder. Matches on a folder
 *  BOUNDARY (`=== folder` or `startsWith(folder + '/')`), never a bare substring, so allowing
 *  `/a/proj` does not leak `/a/project-secret`. */
export const isPathAllowed = (targetPath: string, allowedFolders: readonly string[], caseSensitive: boolean): boolean => {
	const t = normalizeFolderPath(targetPath, caseSensitive);
	for (const f of allowedFolders) {
		const nf = normalizeFolderPath(f, caseSensitive);
		if (nf && (t === nf || t.startsWith(nf + '/'))) { return true; }
	}
	return false;
};

// ── Service ─────────────────────────────────────────────────────────────────────

export type ExternalAccessScope = 'session' | 'workspace';
export interface ExternalAccessEntry { readonly path: string; readonly scope: ExternalAccessScope }

export interface IVibeExternalAccessService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAllowlist: Event<void>;
	/** True when `uri` is under a user-allowed external folder (session or workspace). */
	isAllowed(uri: URI): boolean;
	/** Authorize a folder (the file's containing folder when a file URI is passed). */
	allowFolder(folder: URI, scope: ExternalAccessScope): Promise<void>;
	/** Variant B — prompt the user to authorize the folder containing `uri` (deduped per folder
	 *  while a prompt is in flight). Resolves true if now allowed, false if denied/dismissed. */
	requestAccess(uri: URI): Promise<boolean>;
	/** Current allowlist (session + workspace), for the revoke UI. */
	listAllowed(): ExternalAccessEntry[];
	/** Remove a folder from both scopes (by normalized path equality). */
	revoke(folderPath: string): Promise<void>;
}

export const IVibeExternalAccessService = createDecorator<IVibeExternalAccessService>('vibeExternalAccessService');

export class VibeExternalAccessService extends Disposable implements IVibeExternalAccessService {
	declare readonly _serviceBrand: undefined;

	private readonly _caseSensitive = !isWindows;
	// Session scope is intentionally NOT persisted — cleared on reload (least-privilege default).
	private readonly _session = new Set<string>();
	// Dedup concurrent prompts for the same folder (parallel tools hitting one dir → one modal).
	private readonly _inflight = new Map<string, Promise<boolean>>();

	private readonly _onDidChangeAllowlist = this._register(new Emitter<void>());
	readonly onDidChangeAllowlist: Event<void> = this._onDidChangeAllowlist.event;

	constructor(
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibeModalService private readonly _modal: IVibeModalService,
	) {
		super();
	}

	private _workspaceFolders(): string[] {
		return this._config.getValue<string[]>(PERSISTED_ALLOWLIST_KEY) ?? [];
	}

	isAllowed(uri: URI): boolean {
		return isPathAllowed(uri.fsPath, [...this._session, ...this._workspaceFolders()], this._caseSensitive);
	}

	async allowFolder(folder: URI, scope: ExternalAccessScope): Promise<void> {
		const path = folder.fsPath;
		if (scope === 'session') {
			this._session.add(path);
		} else {
			const norm = normalizeFolderPath(path, this._caseSensitive);
			const current = this._workspaceFolders();
			if (!current.some(p => normalizeFolderPath(p, this._caseSensitive) === norm)) {
				await this._config.updateValue(PERSISTED_ALLOWLIST_KEY, [...current, path], ConfigurationTarget.WORKSPACE);
			}
		}
		this._onDidChangeAllowlist.fire();
	}

	requestAccess(uri: URI): Promise<boolean> {
		if (this.isAllowed(uri)) { return Promise.resolve(true); }
		// Grant at folder granularity — the containing folder of the accessed path.
		const folder = dirname(uri);
		const key = normalizeFolderPath(folder.fsPath, this._caseSensitive);
		const existing = this._inflight.get(key);
		if (existing) { return existing; }
		const prompt = this._modal.showModal<'session' | 'workspace' | 'deny'>({
			title: 'Доступ вне рабочей области',
			body: `Агент запрашивает доступ к файлу вне рабочей области:\n\n${uri.fsPath}\n\nРазрешить доступ к папке «${folder.fsPath}»?`,
			icon: 'warning',
			size: 'medium',
			buttons: [
				{ id: 'deny', label: 'Запретить', role: 'secondary' },
				{ id: 'session', label: 'Разрешить на сессию', role: 'primary' },
				{ id: 'workspace', label: 'Разрешить для проекта', role: 'primary' },
			],
		}).then(async r => {
			if (r.buttonId === 'session' || r.buttonId === 'workspace') {
				await this.allowFolder(folder, r.buttonId);
				return true;
			}
			return false;
		}).finally(() => this._inflight.delete(key));
		this._inflight.set(key, prompt);
		return prompt;
	}

	listAllowed(): ExternalAccessEntry[] {
		const out: ExternalAccessEntry[] = [];
		for (const p of this._session) { out.push({ path: p, scope: 'session' }); }
		for (const p of this._workspaceFolders()) { out.push({ path: p, scope: 'workspace' }); }
		return out;
	}

	async revoke(folderPath: string): Promise<void> {
		const norm = normalizeFolderPath(folderPath, this._caseSensitive);
		// Session: drop matching entries.
		for (const p of [...this._session]) {
			if (normalizeFolderPath(p, this._caseSensitive) === norm) { this._session.delete(p); }
		}
		// Workspace: rewrite setting without the matching entry.
		const current = this._workspaceFolders();
		const next = current.filter(p => normalizeFolderPath(p, this._caseSensitive) !== norm);
		if (next.length !== current.length) {
			await this._config.updateValue(PERSISTED_ALLOWLIST_KEY, next, ConfigurationTarget.WORKSPACE);
		}
		this._onDidChangeAllowlist.fire();
	}
}

registerSingleton(IVibeExternalAccessService, VibeExternalAccessService, InstantiationType.Delayed);
