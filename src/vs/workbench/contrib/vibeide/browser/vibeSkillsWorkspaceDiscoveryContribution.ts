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
import { IVibeSkillsLibraryService } from '../common/vibeSkillsLibraryService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAction } from '../../../../base/common/actions.js';

/**
 * One non-blocking hint per window when the workspace exposes Agent Skills — UX-only;
 * does not change Enterprise→Mode rule precedence (see roadmap § F).
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
		const enabled = this._configurationService.getValue<boolean>('vibeide.skills.workspaceDiscoveryHint') ?? true;
		if (!enabled) {
			return;
		}
		if (!this._workspaceContextService.getWorkspace().folders.length) {
			return;
		}
		let skills;
		try {
			skills = await this._skillsLibrary.getSkills();
		} catch {
			return;
		}
		if (!skills.length) {
			return;
		}
		VibeSkillsWorkspaceDiscoveryContribution._hintShownThisWindow = true;
		const preview = skills
			.slice(0, 4)
			.map(s => s.skillId)
			.join(', ');
		const more = skills.length > 4 ? localize('vibeideSkillsDiscoveryMore', ' (и ещё {0})', skills.length - 4) : '';
		const primary: IAction[] = [{
			id: 'vibeide.skills.discovery.pick',
			label: localize('vibeideSkillsDiscoveryOpenPick', 'Выбрать для сессии…'),
			tooltip: '',
			class: undefined,
			enabled: true,
			run: () => void this._commandService.executeCommand('vibeide.skills.pickSession'),
		}];
		this._notificationService.notify({
			severity: Severity.Info,
			message: localize(
				'vibeideSkillsDiscoveryMsg',
				'В этом воркспейсе подключены навыки агента ({0} шт.): {1}{2}. Используйте /skill:… или команду «Навыки — выбрать для сессии».',
				skills.length,
				preview,
				more,
			),
			actions: { primary },
		});
	}
}

registerWorkbenchContribution2(
	VibeSkillsWorkspaceDiscoveryContribution.ID,
	VibeSkillsWorkspaceDiscoveryContribution,
	WorkbenchPhase.AfterRestored,
);
