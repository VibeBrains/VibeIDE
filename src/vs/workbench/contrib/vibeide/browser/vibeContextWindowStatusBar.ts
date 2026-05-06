/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeContextGuardService } from './vibeContextGuardService.js';
import { IVibeTokenBudgetService } from '../common/vibeTokenBudgetService.js';

/**
 * VibeIDE Context Window Visualizer — statusbar indicator.
 * Live indicator of context window usage during agent tasks.
 * Full panel (Phase 2): shows breakdown by file + cost.
 */
export class VibeContextWindowStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeContextWindowStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeContextGuardService private readonly _contextGuard: IVibeContextGuardService,
		@IVibeTokenBudgetService private readonly _tokenBudget: IVibeTokenBudgetService,
	) {
		super();
		this._entry = this._statusbarService.addEntry(
			this._getEntryProps(),
			'vibeide.contextWindow',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 180 }, alignment: StatusbarAlignment.RIGHT }
		);

		this._register(this._contextGuard.onUsageUpdated(() => {
			this._entry?.update(this._getEntryProps());
		}));

		this._register(this._contextGuard.onContextLimitWarning(() => {
			this._entry?.update(this._getEntryProps());
		}));

		this._register(this._contextGuard.onContextLimitCritical(() => {
			this._entry?.update(this._getEntryProps());
		}));
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
			name: localize('vibeContextWindow', 'VibeIDE Context Window'),
			text: `${contextIcon} CTX${contextPct}${budgetPct}`,
			tooltip: localize(
				'vibeContextWindowTooltip',
				'Context: {0}% ({1}/{2} tokens) | Session budget: {3}%',
				status.percentUsed.toFixed(0),
				status.currentTokens.toLocaleString(),
				status.maxTokens.toLocaleString(),
				budgetStatus.percentUsed.toFixed(0)
			),
			command: 'vibeide.context.status',
			ariaLabel: localize('vibeContextWindowAria', 'Context window: {0}%', status.percentUsed.toFixed(0)),
		};
	}
}

registerWorkbenchContribution2(
	VibeContextWindowStatusBarContribution.ID,
	VibeContextWindowStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
