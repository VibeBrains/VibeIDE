/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';

export type TrustScoreLevel = 'manual' | 'supervised' | 'auto';

const TRUST_SCORE_KEY = 'vibeide.trustScore.level';

/**
 * VibeIDE Trust Score Status Bar Widget.
 *
 * Always visible in statusbar. Changes with one click or keyboard shortcut.
 * 🟢 Manual — каждое действие требует подтверждения
 * 🟡 Supervised — уведомления, автоприменение после таймаута
 * 🔴 Auto — агент работает автономно с budget-лимитами
 *
 * Keyboard shortcut: Ctrl+Shift+T (cycles through levels)
 */
export class VibeTrustScoreStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeTrustScoreStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _level: TrustScoreLevel;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICommandService _commandService: ICommandService,
		@IVibeTokenBudgetService private readonly _tokenBudgetService: IVibeTokenBudgetService,
	) {
		super();
		this._level = (this._configurationService.getValue<TrustScoreLevel>(TRUST_SCORE_KEY)) || 'manual';
		this._createEntry();
		this._registerListeners();
	}

	private _createEntry(): void {
		this._entry = this._statusbarService.addEntry(
			this._getEntryProps(),
			'vibeide.trustScore',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 200 }, alignment: StatusbarAlignment.RIGHT }
		);
	}

	private _registerListeners(): void {
		// Update on config change
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TRUST_SCORE_KEY)) {
				this._level = this._configurationService.getValue<TrustScoreLevel>(TRUST_SCORE_KEY) || 'manual';
				this._entry?.update(this._getEntryProps());
			}
		}));

		// Update on token budget change (show warning when approaching limit)
		this._register(this._tokenBudgetService.onBudgetStatusChanged(() => {
			this._entry?.update(this._getEntryProps());
		}));
	}

	private _getEntryProps(): IStatusbarEntry {
		const budgetStatus = this._tokenBudgetService.getStatus();
		const budgetWarning = budgetStatus.isWarning ? ' ⚠️' : '';

		switch (this._level) {
			case 'manual':
				return {
					name: localize('vibeTrustScore', 'VibeIDE Trust Score'),
					text: `🟢 Manual${budgetWarning}`,
					tooltip: localize('vibeTrustScoreManual', 'Trust Score: Manual — each action requires confirmation. Click to cycle. (Ctrl+Shift+T)'),
					command: 'vibeide.trustScore.toggle',
					ariaLabel: localize('vibeTrustScoreAriaManual', 'Trust Score: Manual'),
				};
			case 'supervised':
				return {
					name: localize('vibeTrustScore', 'VibeIDE Trust Score'),
					text: `🟡 Supervised${budgetWarning}`,
					tooltip: localize('vibeTrustScoreSupervised', 'Trust Score: Supervised — notifications; auto-apply after timeout. Click to cycle. (Ctrl+Shift+T)'),
					command: 'vibeide.trustScore.toggle',
					ariaLabel: localize('vibeTrustScoreAriaSupervised', 'Trust Score: Supervised'),
				};
			case 'auto':
				return {
					name: localize('vibeTrustScore', 'VibeIDE Trust Score'),
					text: `🔴 Auto${budgetWarning}`,
					tooltip: localize('vibeTrustScoreAuto', 'Trust Score: Auto — agent runs autonomously with budget limits. Click to cycle. (Ctrl+Shift+T)'),
					command: 'vibeide.trustScore.toggle',
					ariaLabel: localize('vibeTrustScoreAriaAuto', 'Trust Score: Auto'),
				};
		}
	}

	/** Toggle Trust Score level (Manual → Supervised → Auto → Manual) */
	static cycle(current: TrustScoreLevel): TrustScoreLevel {
		switch (current) {
			case 'manual': return 'supervised';
			case 'supervised': return 'auto';
			case 'auto': return 'manual';
		}
	}
}

registerWorkbenchContribution2(
	VibeTrustScoreStatusBarContribution.ID,
	VibeTrustScoreStatusBarContribution,
	WorkbenchPhase.BlockRestore
);
