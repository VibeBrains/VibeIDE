/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeProviderStatusService, ProviderHealth } from '../common/vibeProviderStatusService.js';
import { IVibeTokenCostForecastService } from '../common/vibeTokenCostForecastService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/**
 * VibeIDE Provider Status Widget.
 * Shows real-time provider health in statusbar.
 * Also shows token cost forecast for last request.
 */
export class VibeProviderStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProviderStatusBar';

	private _providerEntry: IStatusbarEntryAccessor | undefined;
	private _costEntry: IStatusbarEntryAccessor | undefined;
	private _providerRow: IDisposable | undefined;
	private _costRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeProviderStatusService private readonly _providerStatusService: IVibeProviderStatusService,
		@IVibeTokenCostForecastService private readonly _costForecastService: IVibeTokenCostForecastService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._wire();
		this._registerListeners();
	}

	private _wire(): void {
		this._providerEntry?.dispose(); this._providerEntry = undefined;
		this._costEntry?.dispose(); this._costEntry = undefined;
		this._providerRow?.dispose(); this._providerRow = undefined;
		this._costRow?.dispose(); this._costRow = undefined;

		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		const p = this._getProviderEntryProps();
		const c = this._getCostEntryProps();
		if (unifiedOnly) {
			this._providerRow = this._unified.registerRow({
				id: 'vibeide.providerStatus',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				priority: 190,
				command: 'vibeide.transparency.show',
			});
			this._costRow = this._unified.registerRow({
				id: 'vibeide.tokenCost',
				label: c.text,
				tooltip: typeof c.tooltip === 'string' ? c.tooltip : undefined,
				priority: 185,
				command: 'vibeide.tokenBudget.status',
			});
		} else {
			this._providerEntry = this._statusbarService.addEntry(p, 'vibeide.providerStatus', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 190 }, alignment: StatusbarAlignment.RIGHT });
			this._costEntry = this._statusbarService.addEntry(c, 'vibeide.tokenCost', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 185 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _refresh(): void {
		const p = this._getProviderEntryProps();
		const c = this._getCostEntryProps();
		this._providerEntry?.update(p);
		this._costEntry?.update(c);
		if (this._providerRow) {
			this._unified.updateRow('vibeide.providerStatus', { label: p.text, tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined });
		}
		if (this._costRow) {
			this._unified.updateRow('vibeide.tokenCost', { label: c.text, tooltip: typeof c.tooltip === 'string' ? c.tooltip : undefined });
		}
	}

	private _registerListeners(): void {
		this._register(this._providerStatusService.onStatusChanged(() => this._refresh()));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	override dispose(): void {
		this._providerRow?.dispose();
		this._costRow?.dispose();
		this._providerEntry?.dispose();
		this._costEntry?.dispose();
		super.dispose();
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
			name: localize('vibeProviderStatus', 'Статус провайдера VibeIDE'),
			text: displayName,
			tooltip: localize('vibeProviderStatusTooltip', 'Провайдер: {0} — Статус: {1}. Нажмите для проверки.', providerName, healthText),
			command: 'vibeide.transparency.show',
			ariaLabel: localize('vibeProviderStatusAria', 'Провайдер: {0} {1}', providerName, healthText),
		};
	}

	private _getCostEntryProps(): IStatusbarEntry {
		const pricing = this._costForecastService.getPricing('gpt-4o-mini');
		const text = pricing
			? `$(symbol-currency) in ${pricing.inputPer1kTokens.toFixed(3)}/1k`
			: '$(symbol-currency)';
		return {
			name: localize('vibeTokenCost', 'Стоимость токенов VibeIDE'),
			text,
			tooltip: localize('vibeTokenCostTooltip', 'Прогноз стоимости токенов. Запустите задачу, чтобы увидеть оценку.'),
			command: 'vibeide.tokenBudget.status',
			ariaLabel: localize('vibeTokenCostAria', 'Прогноз стоимости токенов'),
		};
	}

	private _healthLabel(health: ProviderHealth): string {
		switch (health) {
			case 'operational': return localize('vibeProviderHealth.operational', 'Работает');
			case 'degraded': return localize('vibeProviderHealth.degraded', 'Деградирует');
			case 'outage': return localize('vibeProviderHealth.outage', 'Недоступен');
			default: return localize('vibeProviderHealth.notChecked', 'Не проверялся');
		}
	}
}

registerWorkbenchContribution2(
	VibeProviderStatusBarContribution.ID,
	VibeProviderStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
