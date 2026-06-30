/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { StatusRowSeverity } from '../common/statusBarRowAggregator.js';

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
	private _unifiedRow: IDisposable | undefined;
	private _level: TrustScoreLevel;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ICommandService _commandService: ICommandService,
		@IVibeTokenBudgetService private readonly _tokenBudgetService: IVibeTokenBudgetService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
	) {
		super();
		this._level = (this._configurationService.getValue<TrustScoreLevel>(TRUST_SCORE_KEY)) || 'manual';
		this._wire();
		this._registerListeners();
	}

	private _wire(): void {
		this._entry?.dispose();
		this._entry = undefined;
		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;

		const unifiedOnly = this._configurationService.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.trustScore',
				label: this._rowLabel(),
				tooltip: this._tooltip(),
				severity: this._severity(),
				priority: 200,
				command: 'vibeide.trustScore.toggle',
			});
		} else {
			this._entry = this._statusbarService.addEntry(
				this._getEntryProps(),
				'vibeide.trustScore',
				StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 200 }, alignment: StatusbarAlignment.RIGHT }
			);
		}
	}

	private _refresh(): void {
		if (this._entry) { this._entry.update(this._getEntryProps()); }
		if (this._unifiedRow) {
			this._unified.updateRow('vibeide.trustScore', {
				label: this._rowLabel(),
				tooltip: this._tooltip(),
				severity: this._severity(),
			});
		}
	}

	private _rowLabel(): string {
		const budgetStatus = this._tokenBudgetService.getStatus();
		const warn = budgetStatus.isWarning ? ' ⚠️' : '';
		switch (this._level) {
			case 'manual': return `🟢 Manual${warn}`;
			case 'supervised': return `🟡 Supervised${warn}`;
			case 'auto': return `🔴 Auto${warn}`;
		}
	}

	private _tooltip(): string {
		switch (this._level) {
			case 'manual': return 'Trust Score: Manual — каждое действие требует подтверждения.';
			case 'supervised': return 'Trust Score: Supervised — уведомления, авто-применение после таймаута.';
			case 'auto': return 'Trust Score: Auto — агент работает автономно с budget-лимитами.';
		}
	}

	private _severity(): StatusRowSeverity {
		const budgetStatus = this._tokenBudgetService.getStatus();
		if (budgetStatus.isWarning) { return 'warn'; }
		if (this._level === 'auto') { return 'warn'; }
		return 'info';
	}

	private _registerListeners(): void {
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(TRUST_SCORE_KEY)) {
				this._level = this._configurationService.getValue<TrustScoreLevel>(TRUST_SCORE_KEY) || 'manual';
				this._refresh();
			}
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) {
				this._wire();
			}
		}));

		this._register(this._tokenBudgetService.onBudgetStatusChanged(() => this._refresh()));
	}

	private _getEntryProps(): IStatusbarEntry {
		const budgetStatus = this._tokenBudgetService.getStatus();
		const budgetWarning = budgetStatus.isWarning ? ' ⚠️' : '';

		switch (this._level) {
			case 'manual':
				return {
					name: localize('vibeTrustScore', 'Индекс доверия VibeIDE'),
					text: localize('vibeTrustScoreTextManual', "🟢 Manual{0}", budgetWarning),
					tooltip: localize('vibeTrustScoreManual', 'Индекс доверия: Manual — каждое действие требует подтверждения. Нажмите для смены. (Ctrl+Shift+T)'),
					command: 'vibeide.trustScore.toggle',
					ariaLabel: localize('vibeTrustScoreAriaManual', 'Индекс доверия: Manual'),
				};
			case 'supervised':
				return {
					name: localize('vibeTrustScore', 'Индекс доверия VibeIDE'),
					text: localize('vibeTrustScoreTextSupervised', "🟡 Supervised{0}", budgetWarning),
					tooltip: localize('vibeTrustScoreSupervised', 'Индекс доверия: Supervised — уведомления; авто-применение после таймаута. Нажмите для смены. (Ctrl+Shift+T)'),
					command: 'vibeide.trustScore.toggle',
					ariaLabel: localize('vibeTrustScoreAriaSupervised', 'Индекс доверия: Supervised'),
				};
			case 'auto':
				return {
					name: localize('vibeTrustScore', 'Индекс доверия VibeIDE'),
					text: localize('vibeTrustScoreTextAuto', "🔴 Auto{0}", budgetWarning),
					tooltip: localize('vibeTrustScoreAuto', 'Индекс доверия: Auto — агент работает автономно с budget-лимитами. Нажмите для смены. (Ctrl+Shift+T)'),
					command: 'vibeide.trustScore.toggle',
					ariaLabel: localize('vibeTrustScoreAriaAuto', 'Индекс доверия: Auto'),
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

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeTrustScoreStatusBarContribution.ID,
	VibeTrustScoreStatusBarContribution,
	WorkbenchPhase.BlockRestore
);
