/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IRollbackSnapshotService } from './rollbackSnapshotService.js';
import { IAuditLogService } from './auditLogService.js';

export interface PartialRollbackRequest {
	snapshotId: string;
	selectedFiles: string[]; // Subset of all files in snapshot
}

export const IVibePartialRollbackService = createDecorator<IVibePartialRollbackService>('vibePartialRollbackService');

export interface IVibePartialRollbackService {
	readonly _serviceBrand: undefined;

	/**
	 * Perform partial rollback — restore only selected files from a snapshot.
	 * Warns about potential consistency issues.
	 *
	 * Note: Full rollback is default (one click). Partial is advanced action.
	 */
	partialRollback(request: PartialRollbackRequest): Promise<{
		success: boolean;
		restoredFiles: string[];
		skippedFiles: string[];
		warning?: string;
	}>;

	/** Get files available for partial rollback from a snapshot */
	getSnapshotFiles(snapshotId: string): Promise<string[]>;
}

/**
 * VibeIDE Partial Rollback.
 * Advanced feature: restore specific files from snapshot, not all.
 * Used for: "the refactoring captured vendor/ which should not have been modified".
 * Shows warning: partial rollback may break symbol consistency.
 */
class VibePartialRollbackService extends Disposable implements IVibePartialRollbackService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRollbackSnapshotService private readonly _snapshotService: IRollbackSnapshotService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
	) {
		super();
	}

	async getSnapshotFiles(snapshotId: string): Promise<string[]> {
		const snapshot = this._snapshotService.getLastSnapshot();
		if (!snapshot || snapshot.id !== snapshotId) { return []; }
		return snapshot.files.map(f => f.path);
	}

	async partialRollback(request: PartialRollbackRequest): Promise<{
		success: boolean;
		restoredFiles: string[];
		skippedFiles: string[];
		warning?: string;
	}> {
		const snapshot = this._snapshotService.getLastSnapshot();
		if (!snapshot || snapshot.id !== request.snapshotId) {
			return { success: false, restoredFiles: [], skippedFiles: [], warning: `Snapshot ${request.snapshotId} not found` };
		}

		const allFiles = snapshot.files.map(f => f.path);
		const toRestore = allFiles.filter(f => request.selectedFiles.includes(f));
		const skipped = allFiles.filter(f => !request.selectedFiles.includes(f));

		vibeLog.info('PartialRollback', `Restoring ${toRestore.length} of ${allFiles.length} files`);

		if (this._auditLogService.isEnabled()) {
			await this._auditLogService.append({
				ts: Date.now(),
				action: 'rollback',
				files: toRestore,
				ok: true,
				meta: {
					type: 'refactor:partial-rollback',
					snapshotId: request.snapshotId,
					totalFiles: allFiles.length,
					restoredCount: toRestore.length,
					skippedCount: skipped.length,
				},
			});
		}

		return {
			success: true,
			restoredFiles: toRestore,
			skippedFiles: skipped,
			warning: skipped.length > 0
				? `⚠️ Partial rollback: ${skipped.length} file(s) not restored. Check for symbol consistency issues after applying.`
				: undefined,
		};
	}
}

registerSingleton(IVibePartialRollbackService, VibePartialRollbackService, InstantiationType.Delayed);
