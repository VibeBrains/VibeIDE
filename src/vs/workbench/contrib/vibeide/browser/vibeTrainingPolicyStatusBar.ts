/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeModelsRegistryService, ModelInfo } from '../common/vibeModelsRegistryService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';

function labelForTrainingPolicy(p: ModelInfo['trainingPolicy']): string {
	switch (p) {
		case 'none': return localize('vibeTrainNone', 'no train');
		case 'opt-in': return localize('vibeTrainOptIn', 'train opt-in');
		case 'opt-out-available': return localize('vibeTrainOptOut', 'train opt-out avail');
		case 'always': return localize('vibeTrainAlways', 'may train');
		default: return localize('vibeTrainUnknown', 'train ?');
	}
}

function describeTrainingPolicy(p: ModelInfo['trainingPolicy'] | undefined): string {
	if (p === undefined) {
		return localize(
			'vibeTrainTooltipUnknown',
			'Training / data use policy for this model is unknown (refresh catalog or check provider docs).'
		);
	}
	switch (p) {
		case 'none':
			return localize('vibeTrainTipNone', 'Provider states this model is not trained on your API data (per VibeIDE catalog).');
		case 'opt-in':
			return localize('vibeTrainTipOptIn', 'Training on your data requires explicit opt-in (per VibeIDE catalog).');
		case 'opt-out-available':
			return localize('vibeTrainTipOptOut', 'Provider may use data for training; an opt-out is available (per VibeIDE catalog).');
		case 'always':
			return localize('vibeTrainTipAlways', 'Provider may use prompts for training under default terms (per VibeIDE catalog).');
	}
}

/**
 * Shows CDN registry-based training-data policy for the current Chat model (compact status bar).
 */
export class VibeTrainingPolicyStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeTrainingPolicyStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeModelsRegistryService private readonly _modelsRegistry: IVibeModelsRegistryService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
		this._entry = this._statusbarService.addEntry(
			this._getEntryProps(),
			'vibeide.trainingPolicy',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 175 }, alignment: StatusbarAlignment.RIGHT }
		);
		this._register(this._settingsService.onDidChangeState(() => this._entry?.update(this._getEntryProps())));
	}

	private _getEntryProps(): IStatusbarEntry {
		const sel = this._settingsService.state.modelSelectionOfFeature['Chat'];
		if (!sel || sel.providerName === 'auto' && sel.modelName === 'auto') {
			return {
				name: localize('vibeTrainingPolicy', 'VibeIDE training policy'),
				text: '📚 train: —',
				tooltip: localize('vibeTrainNoModel', 'Select a Chat model to see training / data-use hint from VibeIDE model catalog.'),
				ariaLabel: localize('vibeTrainAriaNoModel', 'Training policy: not selected'),
			};
		}
		const policy = this._modelsRegistry.getTrainingPolicyForSelection(sel.providerName, sel.modelName);
		const short = policy !== undefined ? labelForTrainingPolicy(policy) : localize('vibeTrainUnknown', 'train ?');
		const tip = describeTrainingPolicy(policy);
		const text = `📚 ${short}`;
		return {
			name: localize('vibeTrainingPolicy', 'VibeIDE training policy'),
			text,
			tooltip: `${sel.providerName}/${sel.modelName}\n${tip}\n\n${localize('vibeTrainCatalogHint', 'Source: registry.vibeide.io/models.json (cached). Not legal advice.')}`,
			ariaLabel: localize('vibeTrainAriaModel', 'Training policy for {0}: {1}', sel.modelName, short),
		};
	}
}

registerWorkbenchContribution2(
	VibeTrainingPolicyStatusBarContribution.ID,
	VibeTrainingPolicyStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
