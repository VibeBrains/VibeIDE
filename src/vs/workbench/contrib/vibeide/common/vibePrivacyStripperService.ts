/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
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

export interface PrivacyStripPatterns {
	workspacePath: string;
	homePath: string;
	username: string;
}

/**
 * Pure helper. No DI, no logging. Strips workspace path, home path and username
 * occurrences from `text` and returns the rewritten string. Empty / too-short
 * pattern values are skipped (safety against stripping too aggressively).
 */
export function stripPrivacyText(text: string, patterns: PrivacyStripPatterns): string {
	if (!text) {
		return text;
	}
	let result = text;

	if (patterns.workspacePath && patterns.workspacePath.length > 3) {
		const escapedPath = patterns.workspacePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// escape doubled each separator backslash to "\\"; collapse that pair (not each
		// char) into a "\ or /" alternation so a single real separator matches.
		result = result.replace(new RegExp(escapedPath.replace(/\\\\/g, '(?:\\\\|/)'), 'gi'), '<workspace>');
	}

	if (patterns.homePath && patterns.homePath.length > 3) {
		const escapedHome = patterns.homePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(new RegExp(escapedHome.replace(/\\\\/g, '(?:\\\\|/)'), 'gi'), '<home>');
	}

	if (patterns.username && patterns.username.length > 2) {
		const escapedUser = patterns.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		result = result.replace(
			new RegExp(`(?:Users|home|user)(?:\\\\|/)${escapedUser}(?=(?:\\\\|/|\\s|$))`, 'gi'),
			'Users/<user>'
		);
	}

	return result;
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
		const result = stripPrivacyText(text, {
			workspacePath: this._workspacePath,
			homePath: this._homePath,
			username: this._username,
		});
		if (result !== text) {
			vibeLog.debug('PrivacyStripper', 'Stripped sensitive path info from prompt');
		}
		return result;
	}
}

registerSingleton(IVibePrivacyStripperService, VibePrivacyStripperService, InstantiationType.Eager);
