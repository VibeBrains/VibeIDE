/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVibeSkillsLibraryService, VibeSkillEntry } from '../common/vibeSkillsLibraryService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { toAction } from '../../../../base/common/actions.js';
import { SKILLS_REVIEW_COMMAND_ID } from '../common/skillApproval.js';

/** How many skill ids a notice names before «и ещё N». */
const PREVIEW_IDS = 4;

/**
 * One non-blocking notice per window when the workspace exposes Agent Skills — UX-only; does not
 * change Enterprise→Mode rule precedence (see roadmap § F).
 *
 * Skills waiting for approval are announced even with the hint switched off: the hint says «here are
 * your skills», this one says «the agent cannot see some of them until you look» — without it a
 * skill would simply stop working, and nothing would say why.
 */
export class VibeSkillsWorkspaceDiscoveryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeSkillsWorkspaceDiscovery';

	private static _hintShownThisWindow = false;

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IVibeSkillsLibraryService private readonly _skillsLibrary: IVibeSkillsLibraryService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		queueMicrotask(() => void this._runOnce());
	}

	private async _runOnce(): Promise<void> {
		if (VibeSkillsWorkspaceDiscoveryContribution._hintShownThisWindow) {
			return;
		}
		if (!this._workspaceContextService.getWorkspace().folders.length) {
			return;
		}
		let skills: VibeSkillEntry[];
		try {
			skills = await this._skillsLibrary.getSkills();
		} catch {
			return;
		}
		if (!skills.length) {
			return;
		}
		const pending = skills.filter(skill => !this._skillsLibrary.isSkillAvailableToModel(skill));
		const hintEnabled = this._configurationService.getValue<boolean>('vibeide.skills.workspaceDiscoveryHint') ?? true;
		if (pending.length === 0 && !hintEnabled) {
			return;
		}
		VibeSkillsWorkspaceDiscoveryContribution._hintShownThisWindow = true;

		const pickAction = toAction({
			id: 'vibeide.skills.discovery.pick',
			label: localize('vibeideSkillsDiscoveryOpenPick', 'Выбрать для сессии…'),
			run: () => this._commandService.executeCommand('vibeide.skills.pickSession'),
		});
		if (pending.length > 0) {
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize(
					'vibeideSkillsDiscoveryPending',
					'Скиллы ждут вашего одобрения ({0} из {1}): {2}{3}. Пока вы их не одобрите, агент их не видит.',
					pending.length,
					skills.length,
					previewIds(pending),
					moreIds(pending),
				),
				actions: {
					primary: [toAction({
						id: 'vibeide.skills.discovery.review',
						label: localize('vibeideSkillsDiscoveryReview', 'Проверить…'),
						run: () => this._commandService.executeCommand(SKILLS_REVIEW_COMMAND_ID),
					}), pickAction],
				},
			});
			return;
		}
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeideSkillsDiscoveryMsg',
				'В этом воркспейсе подключены навыки агента ({0} шт.): {1}{2}. Используйте /skill:… или команду «Навыки — выбрать для сессии».',
				skills.length,
				previewIds(skills),
				moreIds(skills),
			),
			actions: { primary: [pickAction] },
		});
	}
}

function previewIds(skills: readonly VibeSkillEntry[]): string {
	return skills.slice(0, PREVIEW_IDS).map(skill => skill.skillId).join(', ');
}

function moreIds(skills: readonly VibeSkillEntry[]): string {
	return skills.length > PREVIEW_IDS ? localize('vibeideSkillsDiscoveryMore', ' (и ещё {0})', skills.length - PREVIEW_IDS) : '';
}

registerWorkbenchContribution2(
	VibeSkillsWorkspaceDiscoveryContribution.ID,
	VibeSkillsWorkspaceDiscoveryContribution,
	WorkbenchPhase.AfterRestored,
);
