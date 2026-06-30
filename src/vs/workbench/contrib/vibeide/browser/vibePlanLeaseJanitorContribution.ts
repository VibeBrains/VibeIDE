/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Plan-lease periodic janitor (roadmap K.1 L903).
 *
 * Wakes every JANITOR_INTERVAL_MS, enumerates `.vibe/plans/.leases/*.json`
 * across every workspace folder, partitions through `partitionLeases`, and
 * calls `IVibePersistedPlanService.clearExecutionLease` for each stale entry.
 *
 * Pure decision lives in `common/planLeaseLifecycle.ts` (already unit-tested
 * 11 ways). This contribution is the IO wrapper — `IFileService.resolve` for
 * the directory listing, `readFile` for content, `del` for stale removal.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IVibePersistedPlanService } from '../common/vibePersistedPlanService.js';
import {
	PlanExecutionLease,
	decodeLease,
	partitionLeases,
} from '../common/planLeaseLifecycle.js';

const JANITOR_INTERVAL_MS = 30_000;

export class VibePlanLeaseJanitorContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibePlanLeaseJanitor';

	private _timer: number | null = null;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibePersistedPlanService private readonly _persistedPlanService: IVibePersistedPlanService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		// One initial scan after workbench restore, then a periodic loop. The
		// pure helper is cheap; the actual cost is the FS resolve which is
		// bounded by the number of workspace folders × leases/folder (typically 0-3).
		void this._scan();
		this._timer = mainWindow.setInterval(() => { void this._scan(); }, JANITOR_INTERVAL_MS);
		this._register({ dispose: () => { if (this._timer) { mainWindow.clearInterval(this._timer); this._timer = null; } } });
	}

	private async _scan(): Promise<void> {
		const folders = this._workspace.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}
		const now = Date.now();
		for (const folder of folders) {
			try {
				await this._scanFolder(folder.uri, now);
			} catch (e) {
				this._log.warn(`[VibePlanLeaseJanitor] scan failed for ${folder.uri.toString()}: ${(e as Error).message}`);
			}
		}
	}

	private async _scanFolder(folderUri: URI, now: number): Promise<void> {
		const leasesDir = joinPath(folderUri, '.vibe', 'plans', '.leases');
		let dir;
		try {
			dir = await this._fileService.resolve(leasesDir);
		} catch {
			return; // no .leases directory → nothing to do
		}
		if (!dir.children || dir.children.length === 0) {
			return;
		}

		const leases: PlanExecutionLease[] = [];
		for (const child of dir.children) {
			if (child.isDirectory || !child.name.endsWith('.json')) {
				continue;
			}
			try {
				const buf = await this._fileService.readFile(child.resource);
				const parsed = JSON.parse(buf.value.toString());
				const decoded = decodeLease(parsed);
				if (decoded.ok) {
					leases.push(decoded.value);
				} else {
					this._log.warn(`[VibePlanLeaseJanitor] malformed lease ${child.resource.toString()}: ${decoded.reason}`);
				}
			} catch (e) {
				this._log.warn(`[VibePlanLeaseJanitor] failed to read ${child.resource.toString()}: ${(e as Error).message}`);
			}
		}

		const result = partitionLeases(leases, now);
		if (result.stale.length === 0) {
			return;
		}
		this._log.info(`[VibePlanLeaseJanitor] clearing ${result.stale.length} stale lease(s) in ${folderUri.toString()}`);
		for (const stale of result.stale) {
			try {
				await this._persistedPlanService.clearExecutionLease(folderUri, stale.planId);
			} catch (e) {
				this._log.warn(`[VibePlanLeaseJanitor] failed to clear lease ${stale.planId}: ${(e as Error).message}`);
			}
		}
	}
}

registerWorkbenchContribution2(
	VibePlanLeaseJanitorContribution.ID,
	VibePlanLeaseJanitorContribution,
	WorkbenchPhase.AfterRestored,
);
