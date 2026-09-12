/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import { DENY_RULES_IGNORE_CASE } from './agentPathResolution.js';
import { posix } from '../../../../base/common/path.js';
import { dirname } from '../../../../base/common/resources.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IVibeModalService } from './vibeModalService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

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

/** Reference folders: readable by the agent, never writable. See {@link isAllowed}. */
export const READ_ONLY_FOLDERS_KEY = 'vibeide.agent.referenceFolders';

/**
 * Source folders INSIDE the workspace: readable, never writable.
 *
 * `referenceFolders` above only covers paths outside the open workspace — inside it the agent
 * writes wherever it likes, because the workspace boundary was the only question being asked.
 * That leaves no way to keep a folder of raw sources (articles, transcripts, exports) intact
 * while the agent generates knowledge pages FROM them: the one thing that must not be rewritten
 * is the thing it is reading.
 *
 * Paths are relative to a workspace folder root (`raw`, `docs/sources`). Absolute paths work too
 * and are matched as-is.
 */
export const SOURCE_FOLDERS_KEY = 'vibeide.agent.sourceFolders';

// ── Pure core (testable, no DI) ────────────────────────────────────────────────

/**
 * Normalize a folder path for comparison: `\`→`/`, `.` and `..` resolved, trailing slash dropped,
 * NFC, and lowercased when the comparison is case-insensitive.
 *
 * `..` is resolved HERE, not trusted to the caller: a path compared as written lets
 * `/proj/x/../raw/file.md` pass a source folder `/proj/raw` it sits inside. NFC because `й` exists
 * as one code point and as `и` + combining breve, and both name the same file.
 */
export const normalizeFolderPath = (p: string, caseSensitive: boolean): string => {
	const slashed = p.replace(/\\/g, '/').trim();
	if (!slashed) { return ''; }
	const resolved = posix.normalize(slashed).replace(/\/+$/, '').normalize('NFC');
	return caseSensitive ? resolved : resolved.toLowerCase();
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

/**
 * Resolve configured source folders against the workspace roots.
 *
 * A relative entry is expanded against EVERY root rather than just the first: a multi-root
 * workspace with `raw` configured means "the raw folder of each project", and expanding only the
 * first root would silently leave the others writable — the failure mode being guarded against.
 */
export const resolveSourceFolders = (patterns: readonly string[], workspaceRoots: readonly string[]): string[] => {
	const out: string[] = [];
	for (const raw of patterns) {
		const entry = raw?.trim();
		if (!entry) { continue; }
		const isAbsolute = entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry) || entry.includes('://');
		if (isAbsolute) {
			out.push(entry);
			continue;
		}
		const relative = entry.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '');
		if (!relative || relative.startsWith('..')) { continue; } // `..` would escape the root it is anchored to
		for (const root of workspaceRoots) {
			out.push(`${root.replace(/[\\/]+$/, '')}/${relative}`);
		}
	}
	return out;
};

/** Thrown when a tool tries to write into a declared source folder. */
export class SourceFolderReadOnlyError extends Error {
	constructor(readonly uri: URI) {
		super(localize('vibeide.sourceFolder.readOnly', 'Папка объявлена источником: агент читает её, но не изменяет. Путь: {0}. Список папок — настройка `{1}`.', uri.fsPath, SOURCE_FOLDERS_KEY));
		this.name = 'SourceFolderReadOnlyError';
	}
}

/**
 * The revoked-folder list after the user explicitly grants `granted`.
 *
 * A revoke is remembered for the rest of the session so that the agent cannot walk around it by
 * asking again (see {@link IVibeExternalAccessService.requestAccess}). An explicit grant by the
 * same human is the one thing that clears the memory — otherwise a folder revoked by mistake could
 * never be handed back, and the setting would start lying about what is allowed.
 *
 * Both directions count: granting the revoked folder itself clears it, and so does granting a
 * parent of it, because a parent grant already covers everything below.
 */
export function revokedFoldersAfterGrant(revoked: readonly string[], granted: string, caseSensitive: boolean): string[] {
	return revoked.filter(r => !isPathAllowed(r, [granted], caseSensitive) && !isPathAllowed(granted, [r], caseSensitive));
}

// ── Service ─────────────────────────────────────────────────────────────────────

/**
 * How long a grant lives.
 *
 * `run` is the least privilege that is still useful: the agent asked for a folder to finish the
 * task in hand, and when the task ends the reason for the grant ends with it. Before it existed the
 * smallest answer was «на сессию» — a folder opened for one file stayed open until the window was
 * reloaded, which nobody does on purpose.
 */
export type ExternalAccessScope = 'run' | 'session' | 'workspace';
export interface ExternalAccessEntry {
	readonly path: string;
	readonly scope: ExternalAccessScope;
	/** When this grant stops being valid (epoch ms). Absent = until the window or the run ends. */
	readonly expiresAt?: number;
}

/** Configured lifetime of a session grant, in minutes. `0` keeps the old behaviour: until reload. */
export const EXTERNAL_ACCESS_TTL_KEY = 'vibeide.agent.externalAccessTtlMinutes';

/** A session-lifetime grant as the service holds it. */
export interface SessionGrant { readonly scope: 'run' | 'session'; readonly expiresAt?: number }

/**
 * Grants still valid at `now`. Pure, so the rule can be tested without a clock or a service graph.
 *
 * Expiry is decided on READ rather than by a timer: a timer firing in a window nobody is looking at
 * buys nothing, and every question about access already passes through here.
 */
export function liveGrants(grants: ReadonlyMap<string, SessionGrant>, now: number): string[] {
	const live: string[] = [];
	for (const [path, grant] of grants) {
		if (grant.expiresAt === undefined || grant.expiresAt > now) { live.push(path); }
	}
	return live;
}

export interface IVibeExternalAccessService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeAllowlist: Event<void>;
	/**
	 * True when `uri` is under a user-allowed external folder (session or workspace).
	 *
	 * Reference folders count for `read` only. A knowledge base is something to consult, not to
	 * edit, and "don't touch it" in a prompt is a wish while a folder the write path never accepts
	 * is a setting — the wish is the one that fails at 3am.
	 */
	isAllowed(uri: URI, accessKind?: 'read' | 'write'): boolean;
	/** Authorize a folder (the file's containing folder when a file URI is passed). */
	allowFolder(folder: URI, scope: ExternalAccessScope): Promise<void>;
	/** Variant B — prompt the user to authorize the folder containing `uri` (deduped per folder
	 *  while a prompt is in flight). Resolves true if now allowed, false if denied/dismissed. */
	requestAccess(uri: URI): Promise<boolean>;
	/**
	 * True when `uri` sits inside a declared source folder, which the agent may read but never
	 * write. Unlike {@link isAllowed} this applies INSIDE the workspace too — that is the whole
	 * point: the raw material the agent generates knowledge from lives in the repository.
	 */
	isSourceReadOnly(uri: URI): boolean;
	/** Current allowlist (session + workspace), for the revoke UI. */
	listAllowed(): ExternalAccessEntry[];
	/** Remove a folder from both scopes (by normalized path equality). */
	revoke(folderPath: string): Promise<void>;
	/**
	 * True when this path sits under a folder the user revoked during this session. The agent is
	 * refused without a prompt there — see {@link requestAccess}.
	 */
	isRevoked(uri: URI): boolean;
	/**
	 * The current agent turn is over: grants issued «на задачу» end with it.
	 *
	 * Called from the one place a turn finishes, rather than being timed out — a task has no
	 * duration to guess at, and a grant that outlives its reason is the thing this scope removes.
	 */
	endRunScope(): void;
}

export const IVibeExternalAccessService = createDecorator<IVibeExternalAccessService>('vibeExternalAccessService');

export class VibeExternalAccessService extends Disposable implements IVibeExternalAccessService {
	declare readonly _serviceBrand: undefined;

	/** Allow-lists compare exactly on case-sensitive platforms: a mismatch can only err towards refusal. */
	private readonly _caseSensitive = !isWindows;
	/** Deny-lists fold case — one rule for every deny list, see `DENY_RULES_IGNORE_CASE`. */
	private readonly _denyCaseSensitive = !DENY_RULES_IGNORE_CASE;
	// Session scope is intentionally NOT persisted — cleared on reload (least-privilege default).
	// A map rather than a set since grants carry a lifetime: the scope that issued them and, for
	// session grants under a configured TTL, the moment they stop counting.
	private readonly _session = new Map<string, SessionGrant>();
	/**
	 * Folders the user revoked in this session. Kept beyond the allowlist edit on purpose: a run in
	 * flight hits the revoked path on its very next tool call, and the old code answered that by
	 * showing the access prompt again — the agent undid the revoke with a dialog the user had to
	 * fight. Session-lifetime, like the session scope itself.
	 */
	private readonly _revoked = new Set<string>();
	// Dedup concurrent prompts for the same folder (parallel tools hitting one dir → one modal).
	private readonly _inflight = new Map<string, Promise<boolean>>();

	private readonly _onDidChangeAllowlist = this._register(new Emitter<void>());
	readonly onDidChangeAllowlist: Event<void> = this._onDidChangeAllowlist.event;

	constructor(
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibeModalService private readonly _modal: IVibeModalService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	private _workspaceFolders(): string[] {
		return this._config.getValue<string[]>(PERSISTED_ALLOWLIST_KEY) ?? [];
	}

	/** Folders the agent may read but never write — reference material, not working copies. */
	private _referenceFolders(): string[] {
		return this._config.getValue<string[]>(READ_ONLY_FOLDERS_KEY) ?? [];
	}

	isAllowed(uri: URI, accessKind: 'read' | 'write' = 'read'): boolean {
		const writable = [...this._liveSessionFolders(), ...this._workspaceFolders()];
		const folders = accessKind === 'write' ? writable : [...writable, ...this._referenceFolders()];
		return isPathAllowed(uri.fsPath, folders, this._caseSensitive);
	}

	isSourceReadOnly(uri: URI): boolean {
		const patterns = this._config.getValue<string[]>(SOURCE_FOLDERS_KEY) ?? [];
		if (patterns.length === 0) { return false; }
		const roots = this._workspaceContextService.getWorkspace().folders.map(f => f.uri.fsPath);
		return isPathAllowed(uri.fsPath, resolveSourceFolders(patterns, roots), this._denyCaseSensitive);
	}

	/**
	 * Session-scoped folders that are still valid right now. Expired grants are dropped on read
	 * rather than on a timer: a timer that fires in a window nobody is looking at buys nothing, and
	 * every question about access already passes through here.
	 */
	private _liveSessionFolders(): string[] {
		const live = liveGrants(this._session, Date.now());
		if (live.length !== this._session.size) {
			const keep = new Set(live);
			for (const path of [...this._session.keys()]) {
				if (!keep.has(path)) { this._session.delete(path); }
			}
		}
		return live;
	}

	/** Minutes a session grant stays valid, or 0 for «until the window closes». */
	private _sessionTtlMinutes(): number {
		const raw = this._config.getValue<number>(EXTERNAL_ACCESS_TTL_KEY);
		return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
	}

	endRunScope(): void {
		let changed = false;
		for (const [path, grant] of [...this._session]) {
			if (grant.scope === 'run') {
				this._session.delete(path);
				changed = true;
			}
		}
		if (changed) {
			this._onDidChangeAllowlist.fire();
		}
	}

	async allowFolder(folder: URI, scope: ExternalAccessScope): Promise<void> {
		const path = folder.fsPath;
		// An explicit grant by the human outranks their earlier revoke.
		const left = revokedFoldersAfterGrant([...this._revoked], path, this._caseSensitive);
		this._revoked.clear();
		for (const r of left) { this._revoked.add(r); }
		if (scope === 'run' || scope === 'session') {
			const ttl = scope === 'session' ? this._sessionTtlMinutes() : 0;
			this._session.set(path, { scope, ...(ttl > 0 ? { expiresAt: Date.now() + ttl * 60_000 } : {}) });
		} else {
			const norm = normalizeFolderPath(path, this._caseSensitive);
			const current = this._workspaceFolders();
			if (!current.some(p => normalizeFolderPath(p, this._caseSensitive) === norm)) {
				await this._config.updateValue(PERSISTED_ALLOWLIST_KEY, [...current, path], ConfigurationTarget.WORKSPACE);
			}
		}
		this._onDidChangeAllowlist.fire();
	}

	isRevoked(uri: URI): boolean {
		return isPathAllowed(uri.fsPath, [...this._revoked], this._caseSensitive);
	}

	requestAccess(uri: URI): Promise<boolean> {
		if (this.isAllowed(uri)) { return Promise.resolve(true); }
		// Revoked during this session: refuse silently instead of asking again. Asking would put the
		// user back in the dialog they just closed, and answering "нет" in a modal is not how a
		// decision already made should have to be defended.
		if (this.isRevoked(uri)) { return Promise.resolve(false); }
		// Grant at folder granularity — the containing folder of the accessed path.
		const folder = dirname(uri);
		const key = normalizeFolderPath(folder.fsPath, this._caseSensitive);
		const existing = this._inflight.get(key);
		if (existing) { return existing; }
		const prompt = this._modal.showModal<'run' | 'session' | 'workspace' | 'deny'>({
			title: localize('vibeide.externalAccess.title', 'Доступ вне рабочей области'),
			body: `Агент запрашивает доступ к файлу вне рабочей области:\n\n${uri.fsPath}\n\nРазрешить доступ к папке «${folder.fsPath}»?`,
			icon: 'warning',
			size: 'medium',
			// Ordered by increasing privilege, least first: the cheapest answer to «дай доступ ради
			// этой задачи» should be the one nearest to hand, not the one that lasts until reload.
			buttons: [
				{ id: 'deny', label: 'Запретить', role: 'secondary' },
				{ id: 'run', label: 'Разрешить на задачу', role: 'primary' },
				{ id: 'session', label: 'Разрешить на сессию', role: 'primary' },
				{ id: 'workspace', label: 'Разрешить для проекта', role: 'primary' },
			],
		}).then(async r => {
			if (r.buttonId === 'run' || r.buttonId === 'session' || r.buttonId === 'workspace') {
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
		for (const path of this._liveSessionFolders()) {
			const grant = this._session.get(path);
			out.push({ path, scope: grant?.scope ?? 'session', ...(grant?.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}) });
		}
		for (const p of this._workspaceFolders()) { out.push({ path: p, scope: 'workspace' }); }
		return out;
	}

	async revoke(folderPath: string): Promise<void> {
		const norm = normalizeFolderPath(folderPath, this._caseSensitive);
		// Session: drop matching entries.
		for (const p of [...this._session.keys()]) {
			if (normalizeFolderPath(p, this._caseSensitive) === norm) { this._session.delete(p); }
		}
		// Workspace: rewrite setting without the matching entry.
		const current = this._workspaceFolders();
		const next = current.filter(p => normalizeFolderPath(p, this._caseSensitive) !== norm);
		if (next.length !== current.length) {
			await this._config.updateValue(PERSISTED_ALLOWLIST_KEY, next, ConfigurationTarget.WORKSPACE);
		}
		this._revoked.add(folderPath);
		this._onDidChangeAllowlist.fire();
	}
}

registerSingleton(IVibeExternalAccessService, VibeExternalAccessService, InstantiationType.Delayed);
