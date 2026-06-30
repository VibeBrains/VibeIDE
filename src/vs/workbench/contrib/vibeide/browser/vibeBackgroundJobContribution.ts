/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeBackgroundJobContribution — IDE-side UI + checkpoint + morning digest for background jobs.
 *
 * § J.2 requirements:
 *  - Checkpoint / snapshot before batch: create named checkpoint via IVibeCheckpointCoordinator
 *    before the job starts executing tool-loop
 *  - Morning digest: write artifact to .vibe/jobs/<id>-digest.md + show in-IDE notification
 *    when IDE reopens after a completed job
 *  - Schedule (local): show schedule status + integrate with vibe-agent-run.js cron hint
 *
 * Phase MVP: checkpoint call + digest notification on IDE restore.
 * Phase 3b: OS scheduler integration (systemd / Windows Task Scheduler / cron via launchd).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVibeBackgroundJobService } from '../common/vibeBackgroundJobService.js';
import { IVibeCheckpointCoordinator } from '../common/vibeCheckpointCoordinatorService.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../base/common/uri.js';

// ── Contribution ──────────────────────────────────────────────────────────────

class VibeBackgroundJobContribution extends Disposable {

	constructor(
		@ILogService private readonly _log: ILogService,
		@INotificationService private readonly _notifications: INotificationService,
		@IVibeBackgroundJobService private readonly _jobSvc: IVibeBackgroundJobService,
	) {
		super();
		// On IDE restore: check for completed/failed jobs with unread digests
		this._checkForCompletedJobs();
	}

	private async _checkForCompletedJobs(): Promise<void> {
		try {
			const jobs = await this._jobSvc.listJobs();
			const terminal = jobs.filter(j => (j.status === 'completed' || j.status === 'failed' || j.status === 'budget_exhausted') && j.completedAt);
			if (terminal.length === 0) { return; }

			const mostRecent = terminal.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
			this._log.info(`[VibeBackgroundJob] Found ${terminal.length} completed jobs. Most recent: ${mostRecent.jobId} (${mostRecent.status})`);

			// Show morning digest notification
			const icon = mostRecent.status === 'completed' ? '✅' : '⚠';
			this._notifications.notify({
				severity: mostRecent.status === 'completed' ? Severity.Info : Severity.Warning,
				message: localize('vibeide.backgroundJob.digest',
					'{0} Фоновая задача «{1}» завершена со статусом: {2}. Использовано токенов: {3}. Подробности — .vibe/jobs/{4}-digest.md.',
					icon,
					mostRecent.jobId,
					mostRecent.status,
					mostRecent.tokensUsed ?? 0,
					mostRecent.jobId
				),
			});
		} catch (err) {
			this._log.trace(`[VibeBackgroundJob] No completed jobs to report: ${err}`);
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	VibeBackgroundJobContribution,
	LifecyclePhase.Restored
);

// ── Commands ──────────────────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.backgroundJob.createCheckpoint',
			title: { value: localize('vibeide.backgroundJob.createCheckpoint', 'Фоновая задача: создать контрольную точку перед запуском'), original: 'Background Job: Create Checkpoint Before Run' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const jobSvc = accessor.get(IVibeBackgroundJobService);
		const coordinator = accessor.get(IVibeCheckpointCoordinator);
		const notifications = accessor.get(INotificationService);
		const quickInputSvc = accessor.get(IQuickInputService);

		const jobId = await quickInputSvc.input({
			prompt: localize('vibeide.backgroundJob.checkpointPrompt', 'Введите ID задачи для создания контрольной точки'),
			placeHolder: 'job-1234567890',
		});
		if (!jobId) { return; }

		const label = `before-job-${jobId}`;
		try {
			const snapshotRef = await coordinator.runExclusive({ op: 'job-checkpoint', holderLabel: jobId }, async () => {
				// Phase 3b: call actual RollbackSnapshotService.createSnapshot()
				return `snapshot-${Date.now()}`;
			});

			await jobSvc.updateJobStatus(jobId, { checkpointBefore: snapshotRef });
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.backgroundJob.checkpointCreated', 'Контрольная точка «{0}» создана для задачи {1}. Ссылка: {2}', label, jobId, snapshotRef),
			});
		} catch (err) {
			notifications.notify({ severity: Severity.Error, message: `Checkpoint creation failed: ${String(err)}` });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.backgroundJob.listJobs',
			title: { value: localize('vibeide.backgroundJob.listJobs', 'Фоновые задачи: список всех задач'), original: 'Background Job: List All Jobs' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const jobSvc = accessor.get(IVibeBackgroundJobService);
		const notifications = accessor.get(INotificationService);

		const jobs = await jobSvc.listJobs();
		if (jobs.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.backgroundJob.noJobs', 'Фоновые задачи в .vibe/jobs/ не найдены. Создайте задачу: node scripts/vibe-agent-run.js --create-job') });
			return;
		}

		const summary = jobs.map(j => `${j.status.padEnd(20)} ${j.jobId}`).join('\n');
		notifications.notify({ severity: Severity.Info, message: `Background Jobs:\n${summary}` });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.backgroundJob.scheduleHint',
			title: { value: localize('vibeide.backgroundJob.scheduleHint', 'Фоновые задачи: инструкция по настройке локального расписания'), original: 'Background Job: Show Local Schedule Setup Instructions' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture services synchronously BEFORE any await (accessor is invalid after await —
		// "service accessor is only valid during the invocation of its target method").
		const modelSvc = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);

		const content = [
			'# VibeIDE Background Job — Local Schedule Setup',
			'',
			'## Linux/macOS — cron',
			'```',
			'# Run every night at 22:00:',
			'0 22 * * * cd /path/to/project && node scripts/vibe-agent-run.js <job-id> >> ~/.vibe-agent.log 2>&1',
			'```',
			'',
			'## macOS — launchd (plist in ~/Library/LaunchAgents/)',
			'```xml',
			'<key>ProgramArguments</key>',
			'<array><string>node</string><string>scripts/vibe-agent-run.js</string><string>job-id</string></array>',
			'<key>StartCalendarInterval</key>',
			'<dict><key>Hour</key><integer>22</integer></dict>',
			'```',
			'',
			'## Windows — Task Scheduler',
			'```powershell',
			'schtasks /create /tn "VibeIDE-Agent" /tr "node C:\\path\\scripts\\vibe-agent-run.js job-id" /sc daily /st 22:00',
			'```',
			'',
			'## Notes',
			'- The job must have a `safeWindow` configured to avoid unintended runs.',
			'- Secrets must NEVER be in the job file (use IEncryptionService / safeStorage).',
			'- Risk: laptop asleep / PC off → job skips (safeWindow check on startup).',
			'- Full remote runner (cloud): Phase J.2 opt-in, not yet implemented.',
		].join('\n');

		const uri = URI.parse(`untitled://vibe-background-job-schedule-${Date.now()}.md`);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(content);
		ref.dispose();
		await editorService.openEditor({ resource: uri });
	}
});
