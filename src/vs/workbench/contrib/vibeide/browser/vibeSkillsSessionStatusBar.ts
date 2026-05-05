/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

const SESSION_KEY = 'vibeide.skills.sessionActiveIds';

/**
 * Compact indicator when workspace limits which skills appear in GUIDELINES discovery.
 */
export class VibeSkillsSessionStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeSkillsSessionStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._entry = this._statusbarService.addEntry(
			this._entryProps(),
			'vibeide.skills.session',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 173 }, alignment: StatusbarAlignment.RIGHT }
		);
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(SESSION_KEY)) {
				this._entry?.update(this._entryProps());
			}
		}));
	}

	private _entryProps(): IStatusbarEntry {
		const ids = this._configurationService.getValue<string[]>(SESSION_KEY)?.filter(Boolean) ?? [];
		const tipIds = ids.join(', ');
		if (!ids.length) {
			return {
				name: localize('vibeideSkillsSessionSbName', 'VibeIDE session skills'),
				text: '',
				ariaLabel: localize('vibeideSkillsSessionSbAriaIdle', 'Session skill filter: off'),
				tooltip: localize(
					'vibeideSkillsSessionSbTipIdle',
					'No session skill filter. Run “VibeIDE: Skills — select for session” to limit GUIDELINES discovery.'
				),
			};
		}
		return {
			name: localize('vibeideSkillsSessionSbName', 'VibeIDE session skills'),
			text: localize('vibeideSkillsSessionSbText', 'skills:{0}', ids.length),
			ariaLabel: localize('vibeideSkillsSessionSbAria', 'Session skill filter: {0} skills', ids.length),
			tooltip: localize(
				'vibeideSkillsSessionSbTip',
				'Limited discovery to: {0}. Click to re-open picker; palette: “Skills — clear session filter”.',
				tipIds
			),
			command: 'vibeide.skills.pickSession',
		};
	}
}

registerWorkbenchContribution2(
	VibeSkillsSessionStatusBarContribution.ID,
	VibeSkillsSessionStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
