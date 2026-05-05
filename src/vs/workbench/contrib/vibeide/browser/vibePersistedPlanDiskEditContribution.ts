/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService, FileChangesEvent } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { IChatThreadService } from './chatThreadService.js';
import type { PlanMessage } from '../common/chatThreadServiceTypes.js';
import { disposableTimeout } from '../../../../base/common/async.js';

/**
 * When `.vibe/plans/*.plan.md` changes on disk while the same persisted plan is executing in Agent chat,
 * notify once (debounced) — aligns with hot-reload `.vibe/` policy for observability.
 */
export class VibePersistedPlanDiskEditContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibePersistedPlanDiskEdit';

	private readonly _debouncers = new Map<string, IDisposable>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();
		this._register(this._fileService.onDidFilesChange(e => this._onFilesChange(e)));
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._clearDebouncers();
		}));
	}

	private _clearDebouncers(): void {
		for (const d of this._debouncers.values()) {
			d.dispose();
		}
		this._debouncers.clear();
	}

	public override dispose(): void {
		this._clearDebouncers();
		super.dispose();
	}

	private _isPersistedPlanMarkdown(uri: URI): boolean {
		const p = uri.path.toLowerCase();
		return p.endsWith('.plan.md') && p.includes('/.vibe/plans/');
	}

	private _onFilesChange(event: FileChangesEvent): void {
		if (event.rawAdded.length === 0 && event.rawUpdated.length === 0) {
			return;
		}
		for (const uri of [...event.rawAdded, ...event.rawUpdated]) {
			if (this._isPersistedPlanMarkdown(uri)) {
				void this._schedulePlanFileHint(uri);
			}
		}
	}

	private async _schedulePlanFileHint(uri: URI): Promise<void> {
		const key = uri.toString(true);
		const prev = this._debouncers.get(key);
		if (prev) {
			prev.dispose();
		}
		this._debouncers.set(
			key,
			disposableTimeout(() => {
				this._debouncers.delete(key);
				void this._maybeNotifyExecutingMismatch(uri);
			}, 800),
		);
	}

	private async _maybeNotifyExecutingMismatch(uri: URI): Promise<void> {
		let diskPlanId = '';
		try {
			const file = await this._fileService.readFile(uri);
			const text = file.value.toString();
			const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (fm) {
				const m = /^planId:\s*["']?([^"'\s]+)["']?/m.exec(fm[1]);
				if (m) {
					diskPlanId = m[1].trim();
				}
			}
		} catch (e) {
			this._logService.debug('[VibeIDE PlanDiskEdit] skipped:', e);
			return;
		}
		if (!diskPlanId) {
			return;
		}

		const threads = this._chatThreadService.state.allThreads;
		const executing = new Set<string>();
		for (const tid of Object.keys(threads)) {
			const thread = threads[tid];
			if (!thread) {
				continue;
			}
			for (const msg of thread.messages) {
				if (msg.role !== 'plan') {
					continue;
				}
				const p = msg as PlanMessage;
				if (p.persistedPlanId === diskPlanId && p.approvalState === 'executing') {
					executing.add(tid);
					break;
				}
			}
		}
		if (executing.size === 0) {
			return;
		}

		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.planEditedMidExecution',
				'Persisted plan file changed on disk while plan `{0}` is executing. Review steps vs Markdown — subsequent agent turns follow hot-reload policy (.vibe/).',
				diskPlanId,
			),
		});
	}
}

registerWorkbenchContribution2(
	VibePersistedPlanDiskEditContribution.ID,
	VibePersistedPlanDiskEditContribution,
	WorkbenchPhase.AfterRestored,
);
