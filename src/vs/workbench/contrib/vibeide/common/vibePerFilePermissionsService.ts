/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { parseConfigJsonOrDefaults } from './vibeConfigJsonParser.js';
import { DENY_RULES_IGNORE_CASE } from './agentPathResolution.js';

export interface VibePermissions {
	vibeVersion?: string;
	allow_write?: string[];  // glob patterns
	deny_write?: string[];   // glob patterns
	allow_read?: string[];
	deny_read?: string[];
}

export const IVibePerFilePermissionsService = createDecorator<IVibePerFilePermissionsService>('vibePerFilePermissionsService');

export interface IVibePerFilePermissionsService {
	readonly _serviceBrand: undefined;

	/** Check write permission. Returns true if allowed. */
	canWrite(filePath: string): boolean;

	/** Check read permission. Returns true if allowed. */
	canRead(filePath: string): boolean;

	/**
	 * Whether a deny list names this path — the half of `canWrite`/`canRead` that must hold for EVERY
	 * name of a file (a symlink gives one file several). The allow half is asked only about the place
	 * the file really is.
	 */
	isDenied(filePath: string, access: 'read' | 'write'): boolean;

	/**
	 * The loaded permission set. `canWrite`/`canRead` answer for one path; the launch preflight
	 * reports the whole picture before a path is even chosen.
	 */
	getPermissions(): VibePermissions;

	/** Reload permissions from .vibe/permissions.json */
	reload(): Promise<void>;
}

/**
 * Pure helper. Glob match for `filePath` against a single pattern. Splits `**` from `*`
 * and `?`: single-star matches a single segment, `?` a single non-separator char, and
 * `**` matches across segments. A double-star-then-slash token collapses to zero-or-more
 * segments so a "src/[double-star]/foo.ts" pattern also matches "src/foo.ts". Single-star
 * and `?` exclude both `/` and `\` so a glob never silently spans a Windows path
 * separator. Anchored to path-segment boundaries via `(^|/)` ... `($|/)`. Both sides are compared
 * in NFC; `ignoreCase` is for deny lists only (see `isDeniedByPermissions`).
 */
export function matchPermissionPattern(filePath: string, pattern: string, ignoreCase = false): boolean {
	const regexStr = pattern.replace(/\\/g, '/').normalize('NFC')
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*\//g, '§DSS§').replace(/\*\*/g, '§DS§')
		.replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')
		.replace(/§DSS§/g, '(?:.*/)?').replace(/§DS§/g, '.*');
	try {
		return new RegExp(`(^|/)${regexStr}($|/)`, ignoreCase ? 'i' : '').test(filePath.normalize('NFC'));
	} catch {
		return false;
	}
}

/**
 * Pure decision: does a deny list of `permissions` name this path.
 *
 * Kept apart from the allow half because the two are asked about different names of one file: a
 * symlink gives it several, a deny must hold for every one of them, an allow only for the place the
 * file really is. Deny lists fold case wherever the filesystem does (`DENY_RULES_IGNORE_CASE`).
 */
export function isDeniedByPermissions(filePath: string, permissions: VibePermissions, access: 'read' | 'write', ignoreCase = DENY_RULES_IGNORE_CASE): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	const deny = access === 'write' ? permissions.deny_write : permissions.deny_read;
	return !!deny?.some(p => matchPermissionPattern(normalized, p, ignoreCase));
}

/** Deny first, then the allow list if one is set; no allow list means everything not denied. */
function allowedByPermissions(filePath: string, permissions: VibePermissions, access: 'read' | 'write', denyIgnoresCase: boolean): boolean {
	if (isDeniedByPermissions(filePath, permissions, access, denyIgnoresCase)) {
		return false;
	}
	const allow = access === 'write' ? permissions.allow_write : permissions.allow_read;
	if (allow && allow.length > 0) {
		const normalized = filePath.replace(/\\/g, '/');
		return allow.some(p => matchPermissionPattern(normalized, p));
	}
	return true;
}

/**
 * Pure decision: given the user's `permissions` doc and a filesystem path, returns
 * whether write is allowed. Independent of IFileService / DI.
 */
export function canWriteWithPermissions(filePath: string, permissions: VibePermissions, denyIgnoresCase = DENY_RULES_IGNORE_CASE): boolean {
	return allowedByPermissions(filePath, permissions, 'write', denyIgnoresCase);
}

/**
 * Pure decision: read counterpart of `canWriteWithPermissions`.
 */
export function canReadWithPermissions(filePath: string, permissions: VibePermissions, denyIgnoresCase = DENY_RULES_IGNORE_CASE): boolean {
	return allowedByPermissions(filePath, permissions, 'read', denyIgnoresCase);
}

/**
 * VibeIDE Per-file Agent Permissions (.vibe/permissions.json).
 * Whitelist/blacklist specific files for agent access.
 * Works alongside .vibe/constraints.json (constraints = deny rules).
 */
class VibePerFilePermissionsService extends Disposable implements IVibePerFilePermissionsService {
	declare readonly _serviceBrand: undefined;

	private _permissions: VibePermissions = {};
	private readonly _reloadScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._reloadScheduler = this._register(new RunOnceScheduler(() => this.reload(), 500));
		this._watch();
		this.reload();
	}

	getPermissions(): VibePermissions {
		return this._permissions;
	}

	private _permissionsUri(): URI | undefined {
		const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.vibe', 'permissions.json') : undefined;
	}

	/**
	 * Picks up an edit without a window reload. These rules gate every read and write of the agent,
	 * and a rule that works only after a restart looks broken to whoever just saved it —
	 * constraints.json has always been reloaded this way, permissions.json was read once. The folder
	 * is watched rather than the file, so creating the file is noticed too.
	 */
	private _watch(): void {
		const uri = this._permissionsUri();
		if (!uri) { return; }
		const watcher = this._register(this._fileService.createWatcher(dirname(uri), { recursive: false, excludes: [] }));
		this._register(watcher.onDidChange(e => {
			if (e.contains(uri)) { this._reloadScheduler.schedule(); }
		}));
	}

	async reload(): Promise<void> {
		const uri = this._permissionsUri();
		if (!uri) { return; }

		let raw: string | undefined;
		try {
			const content = await this._fileService.readFile(uri);
			raw = content.value.toString();
		} catch (e) {
			if (!(e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				vibeLog.warn('Permissions', 'readFile failed for .vibe/permissions.json:', e);
			}
			this._permissions = {};
			return;
		}
		this._permissions = parseConfigJsonOrDefaults<VibePermissions>(
			raw,
			{},
			reason => this._reportCorruptPermissions(uri, reason),
		);
		vibeLog.debug('Permissions', 'Loaded .vibe/permissions.json');
	}

	private _reportCorruptPermissions(uri: URI, reason: string): void {
		// Empty file = "no permissions saved yet" — a normal state, no banner.
		if (reason === 'empty') { return; }
		vibeLog.warn('Permissions', `.vibe/permissions.json corrupt (${reason}) — using safe defaults (allow all)`);
		this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('vibeide.perFilePerms.corrupt', "VibeIDE: .vibe/permissions.json повреждён ({0}). Применены безопасные дефолты — откройте файл и исправьте JSON, иначе per-file ограничения не действуют.", reason),
			source: 'VibeIDE Permissions',
			actions: {
				primary: [{
					id: 'vibeide.openCorruptPermissions',
					label: localize('vibeide.perFilePerms.openFileAction', "Открыть файл"),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: async () => { await this._fileService.resolve(uri); },
				}],
			},
		});
	}

	canWrite(filePath: string): boolean {
		return canWriteWithPermissions(filePath, this._permissions);
	}

	canRead(filePath: string): boolean {
		return canReadWithPermissions(filePath, this._permissions);
	}

	isDenied(filePath: string, access: 'read' | 'write'): boolean {
		return isDeniedByPermissions(filePath, this._permissions, access);
	}
}

registerSingleton(IVibePerFilePermissionsService, VibePerFilePermissionsService, InstantiationType.Eager);
