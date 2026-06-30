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
import { joinPath } from '../../../../base/common/resources.js';
import { parseConfigJsonOrDefaults } from './vibeConfigJsonParser.js';

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

	/** Reload permissions from .vibe/permissions.json */
	reload(): Promise<void>;
}

/**
 * Pure helper. Glob match for `filePath` against a single pattern. Splits `**` from `*`
 * and `?`: single-star matches a single segment, `?` a single non-separator char, and
 * `**` matches across segments. A double-star-then-slash token collapses to zero-or-more
 * segments so a "src/[double-star]/foo.ts" pattern also matches "src/foo.ts". Single-star
 * and `?` exclude both `/` and `\` so a glob never silently spans a Windows path
 * separator. Anchored to path-segment boundaries via `(^|/)` ... `($|/)`.
 */
export function matchPermissionPattern(filePath: string, pattern: string): boolean {
	const regexStr = pattern.replace(/\\/g, '/')
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*\//g, '§DSS§').replace(/\*\*/g, '§DS§')
		.replace(/\*/g, '[^/\\\\]*').replace(/\?/g, '[^/\\\\]')
		.replace(/§DSS§/g, '(?:.*/)?').replace(/§DS§/g, '.*');
	try {
		return new RegExp(`(^|/)${regexStr}($|/)`).test(filePath);
	} catch {
		return false;
	}
}

/**
 * Pure decision: given the user's `permissions` doc and a filesystem path, returns
 * whether write is allowed. Independent of IFileService / DI.
 */
export function canWriteWithPermissions(filePath: string, permissions: VibePermissions): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	if (permissions.deny_write?.some(p => matchPermissionPattern(normalized, p))) {
		return false;
	}
	if (permissions.allow_write && permissions.allow_write.length > 0) {
		return permissions.allow_write.some(p => matchPermissionPattern(normalized, p));
	}
	return true;
}

/**
 * Pure decision: read counterpart of `canWriteWithPermissions`.
 */
export function canReadWithPermissions(filePath: string, permissions: VibePermissions): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	if (permissions.deny_read?.some(p => matchPermissionPattern(normalized, p))) {
		return false;
	}
	if (permissions.allow_read && permissions.allow_read.length > 0) {
		return permissions.allow_read.some(p => matchPermissionPattern(normalized, p));
	}
	return true;
}

/**
 * VibeIDE Per-file Agent Permissions (.vibe/permissions.json).
 * Whitelist/blacklist specific files for agent access.
 * Works alongside .vibe/constraints.json (constraints = deny rules).
 */
class VibePerFilePermissionsService extends Disposable implements IVibePerFilePermissionsService {
	declare readonly _serviceBrand: undefined;

	private _permissions: VibePermissions = {};

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this.reload();
	}

	async reload(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const uri = joinPath(folders[0].uri, '.vibe', 'permissions.json');
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
}

registerSingleton(IVibePerFilePermissionsService, VibePerFilePermissionsService, InstantiationType.Eager);
