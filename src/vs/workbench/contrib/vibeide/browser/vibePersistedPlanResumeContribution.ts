/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IChatThreadService } from './chatThreadService.js';
import { PlanMessage, PlanStep, StepStatus } from '../common/chatThreadServiceTypes.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IVibePersistedPlanService } from '../common/vibePersistedPlanService.js';
import { IWorkbenchEnvironmentService } from '../../../services/environment/common/environmentService.js';

interface PersistedPlanMachineData {
	planKind: string;
	vibeVersion: string;
	planId: string;
	status: string;
	createdAt: string;
	workspaceRootUri: string;
	boundThreadId: string;
	planMessageIdx: number;
	steps: Array<{
		stepNumber: number;
		description: string;
		tools?: string[];
		files?: string[];
		status: string;
		disabled: boolean;
		checkpointIdx?: number | null;
	}>;
}

interface FoundPlan {
	planId: string;
	fileName: string;
	fileUriStr: string;
	summary: string;
	boundThreadId: string;
	planMessageIdx: number;
	machineData: PersistedPlanMachineData;
	rawContent: string;
}

/**
 * VibeIDE: Persisted Agent Plan Resume.
 *
 * On startup, scans `.vibe/plans/` for interrupted plan files (`status: running`).
 * Shows a prominent notification so the user can resume execution after Reload Window.
 *
 * Phase 2 roadmap item: "Persisted agent plans — resume"
 */
export class VibePersistedPlanResumeContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibePersistedPlanResume';

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@ICommandService private readonly _commandService: ICommandService,
		@IVibePersistedPlanService private readonly _persistedPlanService: IVibePersistedPlanService,
		@IWorkbenchEnvironmentService private readonly _environmentService: IWorkbenchEnvironmentService,
	) {
		super();
		// Delay so all services are fully initialised and thread state is loaded from storage
		setTimeout(() => this._checkForInterruptedPlans(), 2500);
	}

	private async _checkForInterruptedPlans(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const plansDir = joinPath(folders[0].uri, '.vibe', 'plans');

		let planFiles: { name: string }[];
		try {
			const stat = await this._fileService.resolve(plansDir);
			if (!stat.children) { return; }
			planFiles = stat.children.filter(c => !c.isDirectory && c.name.endsWith('.plan.md'));
		} catch {
			// Plans directory doesn't exist yet — nothing to resume
			return;
		}

		const interrupted: FoundPlan[] = [];

		for (const file of planFiles) {
			const fileUri = joinPath(plansDir, file.name);
			try {
				const content = (await this._fileService.readFile(fileUri)).value.toString();
				const parsed = this._parsePlanFile(content);
				if (!parsed) { continue; }

				if (parsed.machineData.status === 'running') {
					interrupted.push({
						...parsed,
						fileName: file.name,
						fileUriStr: fileUri.toString(true),
						rawContent: content,
					});
				}
			} catch (err) {
				vibeLog.warn('PlanResume', `Could not read plan file ${file.name}:`, err);
			}
		}

		vibeLog.info('PlanResume', `Found ${interrupted.length} interrupted plan(s).`);

		for (const plan of interrupted) {
			await this._offerResume(plan);
		}
	}

	private _parsePlanFile(content: string): Omit<FoundPlan, 'fileName' | 'fileUriStr' | 'rawContent'> | null {
		// Extract JSON block: <!-- vibe-plan-machine-context: JSON canonical for tooling / resume -->
		const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
		if (!jsonMatch) { return null; }

		let machineData: PersistedPlanMachineData;
		try {
			machineData = JSON.parse(jsonMatch[1]);
		} catch {
			return null;
		}

		if (machineData.planKind !== 'vibeide.agent-plan') { return null; }

		// Extract summary from markdown
		const summaryMatch = content.match(/## Summary\s*\n+([\s\S]*?)\n+## /);
		const summary = summaryMatch ? summaryMatch[1].trim() : '(no summary)';

		return {
			planId: machineData.planId,
			summary,
			boundThreadId: machineData.boundThreadId,
			planMessageIdx: machineData.planMessageIdx,
			machineData,
		};
	}

	private async _offerResume(plan: FoundPlan): Promise<void> {
		// Check if the original thread is still in memory
		const existingThread = this._chatThreadService.state.allThreads[plan.boundThreadId];
		const hasExistingThread = !!existingThread;

		const folders = this._workspaceContextService.getWorkspace().folders;
		const wf = folders[0]?.uri;
		let leaseNote = '';
		let staleLease = false;
		let foreignLease = false;
		if (wf) {
			const lease = await this._persistedPlanService.readExecutionLease(wf, plan.planId);
			staleLease = this._persistedPlanService.isExecutionLeaseStale(lease);
			const wid = (this._environmentService as { window?: { id: number } }).window?.id;
			if (!staleLease && lease && wid !== undefined && lease.windowId !== undefined && lease.windowId !== wid) {
				foreignLease = true;
			}
			if (staleLease) {
				leaseNote = '\n\n' + localize('vibeide.planResume.staleLease', 'Срок действия лизы выполнения истёк или она отсутствует — можно перехватить или сбросить запуск.');
			} else if (foreignLease) {
				leaseNote = '\n\n' + localize('vibeide.planResume.foreignLease', 'Другое окно ещё может удерживать активную лизу выполнения.');
			}
		}

		const shortSummary = plan.summary.length > 80
			? plan.summary.slice(0, 77) + '…'
			: plan.summary;

		const baseMessage = hasExistingThread
			? localize(
				'vibeide.planResume.hasThread',
				'VibeIDE: Выполнение плана прервано. «{0}» — продолжить с прерванного места?',
				shortSummary,
			)
			: localize(
				'vibeide.planResume.noThread',
				'VibeIDE: Найден прерванный план: «{0}». Исходный поток чата утерян — восстановить план в новом потоке?',
				shortSummary,
			);

		const message = baseMessage + leaseNote;

		const primary = staleLease
			? [
				{
					id: `vibeide.planResume.takeOver.${plan.planId}`,
					label: localize('vibeide.planResume.takeOver', 'Перехватить'),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: async () => {
						if (wf) {
							await this._persistedPlanService.clearExecutionLease(wf, plan.planId);
						}
						await this._resumePlan(plan, hasExistingThread);
					},
				},
				{
					id: `vibeide.planResume.discardRun.${plan.planId}`,
					label: localize('vibeide.planResume.discardRun', 'Сбросить запуск'),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: async () => {
						if (wf) {
							await this._persistedPlanService.clearExecutionLease(wf, plan.planId);
						}
						await this._markPlanPaused(plan);
					},
				},
			]
			: [
				{
					id: `vibeide.planResume.continue.${plan.planId}`,
					label: localize('vibeide.planResume.continueBtn', 'Продолжить план'),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => this._resumePlan(plan, hasExistingThread),
				},
				{
					id: `vibeide.planResume.dismiss.${plan.planId}`,
					label: localize('vibeide.planResume.dismissBtn', 'Отклонить'),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => this._markPlanPaused(plan),
				},
			];

		this._notificationService.notify({
			severity: Severity.Info,
			message,
			actions: {
				primary,
			},
		});
	}

	private async _resumePlan(plan: FoundPlan, hasExistingThread: boolean): Promise<void> {
		try {
			if (hasExistingThread) {
				// Switch to the existing thread — plan message is already there in storage
				this._chatThreadService.switchToThread(plan.boundThreadId);
				vibeLog.info('PlanResume', `Switched to existing thread: ${plan.boundThreadId}`);
			} else {
				// Restore plan into a new thread
				await this._restorePlanInNewThread(plan);
			}

			// Open the sidebar chat so user sees the plan
			try {
				await this._commandService.executeCommand('vibeide.sidebar.open');
			} catch {
				// Sidebar command may have different id in some builds
				try {
					await this._commandService.executeCommand('workbench.view.extension.vibeide-sidebar');
				} catch {
					// Ignore — plan is loaded, user will see it next time they open chat
				}
			}

			// Mark plan file as resumed (status: running again — it will be updated to done/failed as execution proceeds)
			// No change needed if it was already running — leave as-is
			vibeLog.info('PlanResume', `Plan ${plan.planId} offered for resume.`);
		} catch (err) {
			vibeLog.error('PlanResume', 'Error during resume:', err);
		}
	}

	private async _restorePlanInNewThread(plan: FoundPlan): Promise<void> {
		// Open a new (empty) thread
		this._chatThreadService.openNewThread();
		const newThreadId = this._chatThreadService.getCurrentThread().id;

		// Build a PlanMessage from persisted data — all non-disabled steps reset to 'queued'
		const steps: PlanStep[] = plan.machineData.steps.map(s => ({
			stepNumber: s.stepNumber,
			description: s.description,
			tools: s.tools,
			files: s.files,
			status: (s.disabled ? 'skipped' : 'queued') as StepStatus,
			disabled: s.disabled,
			checkpointIdx: s.checkpointIdx ?? undefined,
		}));

		const planMessage: PlanMessage = {
			role: 'plan',
			type: 'agent_plan',
			steps,
			summary: plan.summary,
			approvalState: 'pending', // Awaiting user to click Execute
			persistedPlanId: plan.planId,
		};

		// Inject plan message into the new thread via a dedicated public method
		this._chatThreadService.injectPlanMessage(newThreadId, planMessage);

		vibeLog.info('PlanResume', `Restored plan ${plan.planId} into new thread ${newThreadId}`);
	}

	private async _markPlanPaused(plan: FoundPlan): Promise<void> {
		// Update the .plan.md file status to 'paused' so it won't nag again
		try {
			const folders = this._workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) { return; }

			const wf = folders[0].uri;
			const fileUri = joinPath(this._persistedPlanService.plansDirectoryUri(wf), plan.fileName);

			// Replace `status: running` with `status: paused` in frontmatter
			let updated = plan.rawContent.replace(
				/^(status:\s*)running/m,
				'$1paused',
			);
			// Also update the JSON block
			updated = updated.replace(
				/"status":\s*"running"/,
				'"status": "paused"',
			);

			await this._persistedPlanService.writePlanMarkdown(fileUri, updated);
			vibeLog.info('PlanResume', `Plan ${plan.planId} marked as paused.`);
		} catch (err) {
			vibeLog.warn('PlanResume', 'Could not update plan status to paused:', err);
		}
	}
}

registerWorkbenchContribution2(
	VibePersistedPlanResumeContribution.ID,
	VibePersistedPlanResumeContribution,
	WorkbenchPhase.AfterRestored,
);
