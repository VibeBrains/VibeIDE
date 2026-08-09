/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { vibeLog } from '../common/vibeLog.js';
import {
	IVibeideSCMService,
	IVibeWorkspaceSnapshotService,
	IWorkspaceSnapshotRestorePlan,
} from '../common/vibeideSCMTypes.js';

/**
 * Working-tree snapshots for the chat, resolved against the open folder.
 *
 * Lives in `electron-browser` because the work is git in the main process; the chat depends on the
 * `common` decorator so it stays free of the transport.
 */
class VibeWorkspaceSnapshotService extends Disposable implements IVibeWorkspaceSnapshotService {
	declare readonly _serviceBrand: undefined;

	private readonly _scm: IVibeideSCMService;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super();
		this._scm = ProxyChannel.toService<IVibeideSCMService>(mainProcessService.getChannel('vibeide-channel-scm'));
	}

	/** First workspace folder, or `undefined` when the window has no folder open. */
	private _folderPath(): string | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	async capture(): Promise<string | undefined> {
		const path = this._folderPath();
		if (!path) { return undefined; }
		try {
			return await this._scm.createWorkspaceSnapshot(path);
		} catch (error) {
			// A snapshot is an extra safety net; failing to take one must never break the checkpoint.
			vibeLog.warn('workspaceSnapshot', '[WorkspaceSnapshot] capture failed:', error);
			return undefined;
		}
	}

	async plan(tree: string): Promise<IWorkspaceSnapshotRestorePlan | undefined> {
		const path = this._folderPath();
		if (!path) { return undefined; }
		try {
			return await this._scm.planWorkspaceSnapshotRestore(path, tree);
		} catch (error) {
			vibeLog.warn('workspaceSnapshot', '[WorkspaceSnapshot] plan failed:', error);
			return undefined;
		}
	}

	async prune(liveSnapshotIds: readonly string[]): Promise<number> {
		const path = this._folderPath();
		if (!path) { return 0; }
		try {
			return await this._scm.pruneWorkspaceSnapshots(path, liveSnapshotIds);
		} catch (error) {
			// Housekeeping must never surface as a failure to the user.
			vibeLog.warn('workspaceSnapshot', '[WorkspaceSnapshot] prune failed:', error);
			return 0;
		}
	}

	async restore(tree: string): Promise<IWorkspaceSnapshotRestorePlan> {
		const path = this._folderPath();
		if (!path) { throw new Error('Нет открытой рабочей папки — восстанавливать нечего.'); }
		return this._scm.restoreWorkspaceSnapshot(path, tree);
	}
}

registerSingleton(IVibeWorkspaceSnapshotService, VibeWorkspaceSnapshotService, InstantiationType.Delayed);
