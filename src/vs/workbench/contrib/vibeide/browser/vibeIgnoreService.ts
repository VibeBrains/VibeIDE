/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Reads & watches `<workspace>/.vibe/ignore` and answers `isIgnored(uri)` for the agent's file tools
 * (read_file / search_in_file). The file is the agent-facing exclude list ("what NOT to read"),
 * distinct from `.vibe/.gitignore` (git). Matching is delegated to the pure `vibeIgnore` matcher;
 * this service only owns I/O, the workspace-root → relative-path mapping, and live reload on change.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { createIgnoreMatcher, IgnoreMatcher } from '../common/vibeIgnore.js';
import { vibeLog } from '../common/vibeLog.js';

export const IVibeIgnoreService = createDecorator<IVibeIgnoreService>('vibeIgnoreService');

export interface IVibeIgnoreService {
	readonly _serviceBrand: undefined;
	readonly onDidChange: Event<void>;
	/** True when `uri` is excluded by `.vibe/ignore` — the agent must not read/search it. */
	isIgnored(uri: URI): boolean;
	/** Force a re-read of `.vibe/ignore` from disk. */
	reload(): Promise<void>;
}

class VibeIgnoreService extends Disposable implements IVibeIgnoreService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** Compiled rules; `undefined` = no `.vibe/ignore` present → ignore nothing. */
	private _matcher: IgnoreMatcher | undefined;
	/** Folder that relative paths are computed against (first workspace folder). */
	private _root: URI | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		void this.reload();
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => { void this.reload(); }));
		this._register(this._fileService.onDidFilesChange(e => {
			const uri = this._ignoreUri();
			if (uri && e.affects(uri)) {
				vibeLog.debug('VibeIgnore', '.vibe/ignore changed on disk — reloading');
				void this.reload();
			}
		}));
	}

	private _ignoreUri(): URI | undefined {
		const folder = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return folder ? joinPath(folder, '.vibe', 'ignore') : undefined;
	}

	async reload(): Promise<void> {
		this._root = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		const uri = this._ignoreUri();
		if (!uri) { this._matcher = undefined; this._onDidChange.fire(); return; }
		try {
			const buf = await this._fileService.readFile(uri);
			this._matcher = createIgnoreMatcher(buf.value.toString());
			vibeLog.debug('VibeIgnore', `.vibe/ignore loaded: ${this._matcher.ruleCount} rule(s)`);
		} catch {
			this._matcher = undefined; // absent/unreadable → ignore nothing (never block on error)
		}
		this._onDidChange.fire();
	}

	isIgnored(uri: URI): boolean {
		const matcher = this._matcher;
		const root = this._root;
		if (!matcher || !root) { return false; }
		const rel = relativePath(root, uri);
		// Outside the workspace (undefined or escaping `..`) → not governed by the project's ignore file.
		if (rel === undefined || rel === '' || rel.startsWith('..')) { return false; }
		return matcher.isIgnored(rel);
	}
}

// Delayed: created on first injection (toolsService) — no need to run before an agent touches a file.
registerSingleton(IVibeIgnoreService, VibeIgnoreService, InstantiationType.Delayed);
