/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { joinPath } from '../../../../base/common/resources.js';

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
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this.reload();
	}

	async reload(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return;

		const uri = joinPath(folders[0].uri, '.vibe', 'permissions.json');
		try {
			const content = await this._fileService.readFile(uri);
			this._permissions = JSON.parse(content.value.toString()) as VibePermissions;
			this._logService.debug('[VibeIDE Permissions] Loaded .vibe/permissions.json');
		} catch (e) {
			if (!(e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				this._logService.warn('[VibeIDE Permissions] Failed to parse .vibe/permissions.json:', e);
			}
			this._permissions = {};
		}
	}

	canWrite(filePath: string): boolean {
		const normalized = filePath.replace(/\\/g, '/');

		// Check deny_write first
		if (this._permissions.deny_write?.some(p => this._match(normalized, p))) return false;

		// Check allow_write (if defined, must be in list)
		if (this._permissions.allow_write && this._permissions.allow_write.length > 0) {
			return this._permissions.allow_write.some(p => this._match(normalized, p));
		}

		return true; // default: allow
	}

	canRead(filePath: string): boolean {
		const normalized = filePath.replace(/\\/g, '/');
		if (this._permissions.deny_read?.some(p => this._match(normalized, p))) return false;
		if (this._permissions.allow_read && this._permissions.allow_read.length > 0) {
			return this._permissions.allow_read.some(p => this._match(normalized, p));
		}
		return true;
	}

	private _match(filePath: string, pattern: string): boolean {
		const regexStr = pattern.replace(/\\/g, '/')
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*/g, '§DS§').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
			.replace(/§DS§/g, '.*');
		try {
			return new RegExp(`(^|/)${regexStr}($|/)`).test(filePath);
		} catch { return false; }
	}
}

registerSingleton(IVibePerFilePermissionsService, VibePerFilePermissionsService, InstantiationType.Eager);
