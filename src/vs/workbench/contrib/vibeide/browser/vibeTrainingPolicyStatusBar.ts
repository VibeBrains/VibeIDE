/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeModelsRegistryService, ModelInfo } from '../common/vibeModelsRegistryService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

function labelForTrainingPolicy(p: ModelInfo['trainingPolicy']): string {
	switch (p) {
		case 'none': return localize('vibeTrainNone', 'без обучения');
		case 'opt-in': return localize('vibeTrainOptIn', 'обучение по согласию');
		case 'opt-out-available': return localize('vibeTrainOptOut', 'обучение, отказ возможен');
		case 'always': return localize('vibeTrainAlways', 'возможно обучение');
		default: return localize('vibeTrainUnknown', 'обучение ?');
	}
}

function describeTrainingPolicy(p: ModelInfo['trainingPolicy'] | undefined): string {
	if (p === undefined) {
		return localize(
			'vibeTrainTooltipUnknown',
			'Политика обучения / использования данных для этой модели неизвестна (обновите каталог или проверьте документацию провайдера).'
		);
	}
	switch (p) {
		case 'none':
			return localize('vibeTrainTipNone', 'Провайдер заявляет, что данная модель не обучается на ваших данных API (согласно каталогу VibeIDE).');
		case 'opt-in':
			return localize('vibeTrainTipOptIn', 'Обучение на ваших данных требует явного согласия (согласно каталогу VibeIDE).');
		case 'opt-out-available':
			return localize('vibeTrainTipOptOut', 'Провайдер может использовать данные для обучения; доступен отказ (согласно каталогу VibeIDE).');
		case 'always':
			return localize('vibeTrainTipAlways', 'Провайдер может использовать запросы для обучения на стандартных условиях (согласно каталогу VibeIDE).');
	}
}

/**
 * Shows CDN registry-based training-data policy for the current Chat model (compact status bar).
 */
export class VibeTrainingPolicyStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeTrainingPolicyStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeModelsRegistryService private readonly _modelsRegistry: IVibeModelsRegistryService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._wire();
		this._register(this._settingsService.onDidChangeState(() => this._refresh()));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private _wire(): void {
		this._entry?.dispose(); this._entry = undefined;
		this._unifiedRow?.dispose(); this._unifiedRow = undefined;
		const p = this._getEntryProps();
		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.trainingPolicy',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				priority: 175,
			});
		} else {
			this._entry = this._statusbarService.addEntry(p, 'vibeide.trainingPolicy', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 175 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _refresh(): void {
		const p = this._getEntryProps();
		this._entry?.update(p);
		if (this._unifiedRow) {
			this._unified.updateRow('vibeide.trainingPolicy', { label: p.text, tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined });
		}
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}

	private _getEntryProps(): IStatusbarEntry {
		const sel = this._settingsService.state.modelSelectionOfFeature['Chat'];
		if (!sel || sel.providerName === 'auto' && sel.modelName === 'auto') {
			return {
				name: localize('vibeTrainingPolicy', 'Политика обучения VibeIDE'),
				text: localize('vibeTrainingPolicyTextNoModel', '📚 обучение: —'),
				tooltip: localize('vibeTrainNoModel', 'Выберите модель чата, чтобы увидеть подсказку об обучении / использовании данных из каталога моделей VibeIDE.'),
				ariaLabel: localize('vibeTrainAriaNoModel', 'Политика обучения: не выбрана'),
			};
		}
		const policy = this._modelsRegistry.getTrainingPolicyForSelection(sel.providerName, sel.modelName);
		const short = policy !== undefined ? labelForTrainingPolicy(policy) : localize('vibeTrainUnknown', 'обучение ?');
		const tip = describeTrainingPolicy(policy);
		const text = `📚 ${short}`;
		return {
			name: localize('vibeTrainingPolicy', 'Политика обучения VibeIDE'),
			text,
			tooltip: `${sel.providerName}/${sel.modelName}\n${tip}\n\n${localize('vibeTrainCatalogHint', 'Источник: registry.vibeide.io/models.json (кеш). Не является юридической консультацией.')}`,
			ariaLabel: localize('vibeTrainAriaModel', 'Политика обучения для {0}: {1}', sel.modelName, short),
		};
	}
}

registerWorkbenchContribution2(
	VibeTrainingPolicyStatusBarContribution.ID,
	VibeTrainingPolicyStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
