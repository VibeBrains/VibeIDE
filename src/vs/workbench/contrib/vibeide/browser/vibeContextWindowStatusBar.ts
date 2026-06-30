/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeContextGuardService } from './vibeContextGuardService.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { StatusRowSeverity } from '../common/statusBarRowAggregator.js';

/**
 * VibeIDE Context Window Visualizer — statusbar indicator.
 * Live indicator of context window usage during agent tasks.
 * Full panel (Phase 2): shows breakdown by file + cost.
 */
export class VibeContextWindowStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeContextWindowStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeContextGuardService private readonly _contextGuard: IVibeContextGuardService,
		@IVibeTokenBudgetService private readonly _tokenBudget: IVibeTokenBudgetService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._wire();
		this._register(this._contextGuard.onUsageUpdated(() => this._refresh()));
		this._register(this._contextGuard.onContextLimitWarning(() => this._refresh()));
		this._register(this._contextGuard.onContextLimitCritical(() => this._refresh()));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private _wire(): void {
		this._entry?.dispose(); this._entry = undefined;
		this._unifiedRow?.dispose(); this._unifiedRow = undefined;
		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		const p = this._getEntryProps();
		const status = this._contextGuard.getStatus();
		const sev: StatusRowSeverity = status.isCritical ? 'error' : status.isWarning ? 'warn' : 'info';
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.contextWindow',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				severity: sev,
				priority: 180,
				command: 'vibeide.context.status',
			});
		} else {
			this._entry = this._statusbarService.addEntry(p, 'vibeide.contextWindow', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 180 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _refresh(): void {
		const p = this._getEntryProps();
		const status = this._contextGuard.getStatus();
		const sev: StatusRowSeverity = status.isCritical ? 'error' : status.isWarning ? 'warn' : 'info';
		this._entry?.update(p);
		if (this._unifiedRow) {
			this._unified.updateRow('vibeide.contextWindow', { label: p.text, tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined, severity: sev });
		}
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}

	private _getEntryProps(): IStatusbarEntry {
		const status = this._contextGuard.getStatus();
		const budgetStatus = this._tokenBudget.getStatus();

		const contextIcon = status.isCritical ? '🔴' : status.isWarning ? '🟡' : '🟢';
		const contextPct = status.maxTokens > 0 ? ` ${status.percentUsed.toFixed(0)}%` : '';

		const budgetPct = budgetStatus.sessionTokensLimit > 0
			? ` | Budget: ${budgetStatus.percentUsed.toFixed(0)}%`
			: '';

		return {
			name: localize('vibeContextWindow', 'Контекстное окно VibeIDE'),
			text: `${contextIcon} CTX${contextPct}${budgetPct}`,
			tooltip: localize(
				'vibeContextWindowTooltip',
				'Контекст: {0}% ({1}/{2} токенов) | Бюджет сессии: {3}%',
				status.percentUsed.toFixed(0),
				status.currentTokens.toLocaleString(),
				status.maxTokens.toLocaleString(),
				budgetStatus.percentUsed.toFixed(0)
			),
			command: 'vibeide.context.status',
			ariaLabel: localize('vibeContextWindowAria', 'Контекстное окно: {0}%', status.percentUsed.toFixed(0)),
		};
	}
}

registerWorkbenchContribution2(
	VibeContextWindowStatusBarContribution.ID,
	VibeContextWindowStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
