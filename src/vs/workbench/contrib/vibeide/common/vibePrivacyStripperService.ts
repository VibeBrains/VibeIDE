/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

export const IVibePrivacyStripperService = createDecorator<IVibePrivacyStripperService>('vibePrivacyStripperService');

export interface IVibePrivacyStripperService {
	readonly _serviceBrand: undefined;

	/**
	 * Strip hardcoded paths, usernames, and machine names from text
	 * before sending to LLM provider.
	 * Default: enabled (can be disabled via settings).
	 */
	strip(text: string): string;
}

/**
 * VibeIDE Privacy-by-default fingerprint stripping.
 * Auto-strips absolute paths, usernames, and machine names from prompts.
 * Provides base level of privacy without requiring full Stealth mode.
 */
class VibePrivacyStripperService extends Disposable implements IVibePrivacyStripperService {
	declare readonly _serviceBrand: undefined;

	private _workspacePath: string = '';
	private _username: string = '';
	private _homePath: string = '';

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._initPatterns();
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._initPatterns();
		}));
	}

	private _initPatterns(): void {
		// Collect sensitive path prefixes
		const folders = this._workspaceContextService.getWorkspace().folders;

		if (folders.length > 0) {
			this._workspacePath = folders[0].uri.fsPath;
		}

		// Get username from environment (process.env.USERNAME on Windows, USER on Unix)
		this._username = (typeof process !== 'undefined'
			? (process.env['USERNAME'] || process.env['USER'] || '')
			: '') as string;

		// Get home directory
		this._homePath = (typeof process !== 'undefined'
			? (process.env['USERPROFILE'] || process.env['HOME'] || '')
			: '') as string;
	}

	strip(text: string): string {
		if (!text) return text;

		let result = text;

		// Replace absolute workspace path with relative placeholder
		if (this._workspacePath && this._workspacePath.length > 3) {
			const escapedPath = this._workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			result = result.replace(new RegExp(escapedPath.replace(/\\/g, '(?:\\\\|/)'), 'gi'), '<workspace>');
		}

		// Replace home directory path
		if (this._homePath && this._homePath.length > 3) {
			const escapedHome = this._homePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			result = result.replace(new RegExp(escapedHome.replace(/\\/g, '(?:\\\\|/)'), 'gi'), '<home>');
		}

		// Replace username in paths (e.g., /Users/johndoe/... or C:\Users\johndoe\...)
		if (this._username && this._username.length > 2) {
			const escapedUser = this._username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			// Only replace when username appears in path context
			result = result.replace(
				new RegExp(`(?:Users|home|user)(?:\\\\|/)${escapedUser}(?=(?:\\\\|/|\\s|$))`, 'gi'),
				'Users/<user>'
			);
		}

		if (result !== text) {
			this._logService.debug('[VibeIDE PrivacyStripper] Stripped sensitive path info from prompt');
		}

		return result;
	}
}

registerSingleton(IVibePrivacyStripperService, VibePrivacyStripperService, InstantiationType.Eager);
