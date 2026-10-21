/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SnapshotCommitMeta } from '../common/workspaceSnapshotPolicy.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IEditCodeService } from '../browser/editCodeServiceInterface.js';
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
export class VibeWorkspaceSnapshotService extends Disposable implements IVibeWorkspaceSnapshotService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibeideSCMService private readonly _scm: IVibeideSCMService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IEditCodeService private readonly _editCode: IEditCodeService,
		@ITextFileService private readonly _textFiles: ITextFileService,
	) {
		super();
	}

	/** First workspace folder, or `undefined` when the window has no folder open. */
	private _folderPath(): string | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri.fsPath;
	}

	async capture(meta?: SnapshotCommitMeta, previousCommit?: string): Promise<string | undefined> {
		const path = this._folderPath();
		if (!path) { return undefined; }
		try {
			return await this._scm.createWorkspaceSnapshot(path, meta, previousCommit);
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
		const done = await this._scm.restoreWorkspaceSnapshot(path, tree);
		await this._reconcileEditor(path, done);
		return done;
	}

	/**
	 * Редактор узнаёт о возврате папки: у файлов на разборе правок текст теперь тот, что записан на диск
	 *
	 * Зона разбора помнит текст «до» для прежнего состояния файла, и после возврата она показывала бы правку, которой уже нет
	 * Её отклонение записало бы в файл текст, которого там быть не должно, поэтому зона снимается, а сам текст остаётся как есть
	 * Модель файла после этого берёт текст с диска; файл с несохранёнными правками человека не перечитывается
	 */
	private async _reconcileEditor(root: string, done: IWorkspaceSnapshotRestorePlan): Promise<void> {
		const rootUri = URI.file(root);
		const touched = new Set([...done.restore, ...done.delete].map(relative => URI.joinPath(rootUri, relative).fsPath));
		for (const [fsPath, zones] of Object.entries(this._editCode.diffAreasOfURI)) {
			if (!zones || zones.size === 0 || !touched.has(fsPath)) { continue; }
			const uri = URI.file(fsPath);
			await this._editCode.acceptOrRejectAllDiffAreas({ uri, removeCtrlKs: false, behavior: 'accept', _addToHistory: false });
			try {
				await this._textFiles.files.resolve(uri, { reload: { async: false } });
			} catch {
				// Файл, которого после возврата нет, перечитывать нечем: зона уже снята, остальное сделает редактор
			}
		}
	}
}

registerSingleton(IVibeWorkspaceSnapshotService, VibeWorkspaceSnapshotService, InstantiationType.Delayed);
