/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeProviderStatusService, ProviderHealth } from '../common/vibeProviderStatusService.js';
import { IVibeTokenCostForecastService } from '../common/vibeTokenCostForecastService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';

/**
 * VibeIDE Provider Status Widget.
 * Shows real-time provider health in statusbar.
 * Also shows token cost forecast for last request.
 */
export class VibeProviderStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProviderStatusBar';

	private _providerEntry: IStatusbarEntryAccessor | undefined;
	private _costEntry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeProviderStatusService private readonly _providerStatusService: IVibeProviderStatusService,
		@IVibeTokenCostForecastService private readonly _costForecastService: IVibeTokenCostForecastService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
		this._createEntries();
		this._registerListeners();
	}

	private _createEntries(): void {
		// Provider health indicator
		this._providerEntry = this._statusbarService.addEntry(
			this._getProviderEntryProps(),
			'vibeide.providerStatus',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 190 }, alignment: StatusbarAlignment.RIGHT }
		);

		// Token cost display
		this._costEntry = this._statusbarService.addEntry(
			this._getCostEntryProps(),
			'vibeide.tokenCost',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 185 }, alignment: StatusbarAlignment.RIGHT }
		);
	}

	private _registerListeners(): void {
		this._register(this._providerStatusService.onStatusChanged(() => {
			this._providerEntry?.update(this._getProviderEntryProps());
			this._costEntry?.update(this._getCostEntryProps());
		}));
	}

	private _getProviderEntryProps(): IStatusbarEntry {
		const modelSelection = this._settingsService.state.modelSelectionOfFeature?.['Chat'];
		const providerName = modelSelection?.providerName || 'unknown';
		const modelName = modelSelection?.modelName || '';

		const health = this._providerStatusService.isHealthy(providerName)
			? '✅' : '⚠️';

		const displayName = modelName
			? `${health} ${modelName.split('-').slice(0, 3).join('-')}`
			: `${health} ${providerName}`;

		const healthStatus = this._providerStatusService.getAllStatuses().get(providerName);
		const healthText = this._healthLabel(healthStatus?.health || 'unknown');

		return {
			name: localize('vibeProviderStatus', 'VibeIDE Provider Status'),
			text: displayName,
			tooltip: localize('vibeProviderStatusTooltip', 'Provider: {0} — Status: {1}. Click to check.', providerName, healthText),
			command: 'vibeide.transparency.show',
			ariaLabel: localize('vibeProviderStatusAria', 'Provider: {0} {1}', providerName, healthText),
		};
	}

	private _getCostEntryProps(): IStatusbarEntry {
		const pricing = this._costForecastService.getPricing('gpt-4o-mini');
		const text = pricing
			? `$(symbol-currency) in ${pricing.inputPer1kTokens.toFixed(3)}/1k`
			: '$(symbol-currency)';
		return {
			name: localize('vibeTokenCost', 'VibeIDE Token Cost'),
			text,
			tooltip: localize('vibeTokenCostTooltip', 'Token cost forecast. Run a task to see estimate.'),
			command: 'vibeide.tokenBudget.status',
			ariaLabel: localize('vibeTokenCostAria', 'Token cost forecast'),
		};
	}

	private _healthLabel(health: ProviderHealth): string {
		switch (health) {
			case 'operational': return localize('vibeProviderHealth.operational', 'Operational');
			case 'degraded': return localize('vibeProviderHealth.degraded', 'Degraded');
			case 'outage': return localize('vibeProviderHealth.outage', 'Outage');
			default: return localize('vibeProviderHealth.notChecked', 'Not checked');
		}
	}
}

registerWorkbenchContribution2(
	VibeProviderStatusBarContribution.ID,
	VibeProviderStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
