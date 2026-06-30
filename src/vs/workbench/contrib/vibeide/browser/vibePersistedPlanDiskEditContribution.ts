/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService, FileChangesEvent } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { IChatThreadService } from './chatThreadService.js';
import type { PlanMessage } from '../common/chatThreadServiceTypes.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { diffPlans, renderPlanDiffSummary, PlanLite, PlanStepLite } from '../common/planDiffComparator.js';

/**
 * When `.vibe/plans/*.plan.md` changes on disk while the same persisted plan is executing in Agent chat,
 * notify once (debounced) — aligns with hot-reload `.vibe/` policy for observability.
 */
export class VibePersistedPlanDiskEditContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibePersistedPlanDiskEdit';

	private readonly _debouncers = new Map<string, IDisposable>();
	// Owns timeouts created in `_schedulePlanFileHint`. `disposableTimeout` with
	// a store auto-leaks (cleans) the disposable when the timer fires; without
	// the store the wrapper lingered until GC and tripped the leak tracker.
	private readonly _debouncerStore = this._register(new DisposableStore());

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
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
			}, 800, this._debouncerStore),
		);
	}

	private async _maybeNotifyExecutingMismatch(uri: URI): Promise<void> {
		let diskText = '';
		let diskPlanId = '';
		try {
			const file = await this._fileService.readFile(uri);
			diskText = file.value.toString();
			const fm = diskText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
			if (fm) {
				const m = /^planId:\s*["']?([^"'\s]+)["']?/m.exec(fm[1]);
				if (m) {
					diskPlanId = m[1].trim();
				}
			}
		} catch (e) {
			vibeLog.debug('PlanDiskEdit', 'skipped:', e);
			return;
		}
		if (!diskPlanId) {
			return;
		}

		const threads = this._chatThreadService.state.allThreads;
		let executingPlan: PlanMessage | undefined;
		for (const tid of Object.keys(threads)) {
			const thread = threads[tid];
			if (!thread) { continue; }
			for (const msg of thread.messages) {
				if (msg.role !== 'plan') { continue; }
				const p = msg as PlanMessage;
				if (p.persistedPlanId === diskPlanId && p.approvalState === 'executing') {
					executingPlan = p;
					break;
				}
			}
			if (executingPlan) { break; }
		}
		if (!executingPlan) { return; }

		const before: PlanLite = {
			planId: diskPlanId,
			title: executingPlan.summary,
			steps: executingPlan.steps.map(s => ({
				id: String(s.stepNumber),
				title: `Step ${s.stepNumber}: ${s.description.split('\n')[0]}`,
				description: s.description,
				status: s.status,
			} satisfies PlanStepLite)),
		};
		const after = this._parseDiskPlan(diskText, diskPlanId);

		const diff = diffPlans(before, after);
		const diffSummary = renderPlanDiffSummary(diff);

		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.planEditedMidExecution',
				'План `{0}` изменён на диске во время выполнения — {1}. Последующие ходы агента следуют политике hot-reload .vibe/.',
				diskPlanId,
				diffSummary,
			),
		});
	}

	private _parseDiskPlan(text: string, planId: string): PlanLite {
		const steps: PlanStepLite[] = [];
		const stepsMatch = text.match(/## Steps\r?\n([\s\S]*?)(?:\r?\n##|$)/);
		if (stepsMatch) {
			for (const line of stepsMatch[1].split(/\r?\n/)) {
				const m = line.match(/^-\s+(?:~~)?(?:\[[ x]\]\s+)?Step\s+(\d+):\s*(.+?)(?:~~)?(?:\s*_\(skipped\)_\s*)?$/);
				if (!m) { continue; }
				const status = line.includes('[x]') ? 'succeeded' : line.startsWith('- ~~') ? 'skipped' : 'queued';
				steps.push({ id: m[1], title: localize('vibeide.planStepTitle', 'Шаг {0}: {1}', m[1], m[2].trim()), status });
			}
		}
		const summaryMatch = text.match(/## Summary\r?\n\r?\n([\s\S]*?)(?:\r?\n##|$)/);
		const title = summaryMatch ? summaryMatch[1].trim() : undefined;
		return { planId, title, steps };
	}
}

registerWorkbenchContribution2(
	VibePersistedPlanDiskEditContribution.ID,
	VibePersistedPlanDiskEditContribution,
	WorkbenchPhase.AfterRestored,
);
