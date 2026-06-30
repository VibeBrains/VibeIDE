/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayInfoOfProviderName, FeatureName, featureNames, isFeatureNameDisabled, ModelSelection, modelSelectionsEqual, ProviderName, providerNames, SettingsOfProvider } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsTypes.js';
import { useSettingsState, useRefreshModelState, useAccessor } from '../util/services.js';
import { _VibeSelectBox, VibeCustomDropdownBox } from '../util/inputs.js';
import { SelectBox } from '../../../../../../../base/browser/ui/selectBox/selectBox.js';
import { IconWarning } from '../sidebar-tsx/SidebarChat.js';
import { VIBEIDE_OPEN_SETTINGS_ACTION_ID, VIBEIDE_TOGGLE_SETTINGS_ACTION_ID } from '../../../vibeideSettingsPane.js';
import { modelFilterOfFeatureName, ModelOption } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsService.js';
import { WarningBox } from './WarningBox.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { modelDdS } from './vibeSettingsRu.js';

const optionsEqual = (m1: ModelOption[], m2: ModelOption[]) => {
	if (m1.length !== m2.length) {return false;}
	for (let i = 0; i < m1.length; i++) {
		if (!modelSelectionsEqual(m1[i].selection, m2[i].selection)) {return false;}
	}
	return true;
};

const ModelSelectBox = ({ options, featureName, className }: { options: ModelOption[]; featureName: FeatureName; className: string }) => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');

	const selection = vibeideSettingsService.state.modelSelectionOfFeature[featureName];
	// Fall back to options[0] when the saved selection isn't found in _modelOptions (stale/removed
	// model). `.find(...)!` previously lied — it could return undefined, which fed VibeCustomDropdownBox
	// an undefined selectedOption and tripped its auto-select loop. `options` is guaranteed non-empty
	// here (MemoizedModelDropdown renders a WarningBox when there are no options).
	const selectedOption = (selection && vibeideSettingsService.state._modelOptions.find(v => modelSelectionsEqual(v.selection, selection))) || options[0];

	const onChangeOption = useCallback((newOption: ModelOption) => {
		vibeideSettingsService.setModelSelectionOfFeature(featureName, newOption.selection);
	}, [vibeideSettingsService, featureName]);

	return <VibeCustomDropdownBox
		options={options}
		selectedOption={selectedOption}
		onChangeOption={onChangeOption}
		dropdownQuickSearch={true}
		dropdownSearchPlaceholder={modelDdS.searchModels}
		dropdownSearchEmptyMessage={modelDdS.noModelSearchMatches}
		getOptionDisplayName={(option) => {
			// Special display for "Auto" option
			if (option.selection.providerName === 'auto' && option.selection.modelName === 'auto') {
				return modelDdS.auto;
			}
			return option.selection.modelName;
		}}
		getOptionDropdownName={(option) => {
			if (option.selection.providerName === 'auto' && option.selection.modelName === 'auto') {
				return modelDdS.auto;
			}
			return option.selection.modelName;
		}}
		getOptionDropdownDetail={(option) => {
			if (option.selection.providerName === 'auto' && option.selection.modelName === 'auto') {
				return modelDdS.autoDetail;
			}
			return displayInfoOfProviderName(option.selection.providerName).title;
		}}
		getOptionBadge={(option) => {
			// Dynamic-provider models flag their provenance with a trailing "✎" — the pencil's tooltip
			// tells the user the model / its caps come from .vibe/providers.json, not the live catalog.
			const tooltip = option.fileNote === 'override' ? modelDdS.fileNoteOverride
				: option.fileNote === 'manual' ? modelDdS.fileNoteManual
					: undefined;
			return tooltip ? { glyph: '✎', tooltip } : undefined;
		}}
		getOptionsEqual={(a, b) => optionsEqual([a], [b])}
		className={className}
		matchInputWidth={false}
	/>;
};


const MemoizedModelDropdown = ({ featureName, className }: { featureName: FeatureName; className: string }) => {
	const settingsState = useSettingsState();
	const oldOptionsRef = useRef<ModelOption[]>([]);
	const [memoizedOptions, setMemoizedOptions] = useState(oldOptionsRef.current);

	const { filter, emptyMessage } = modelFilterOfFeatureName[featureName];

	useEffect(() => {
		const oldOptions = oldOptionsRef.current;
		// For Chat feature, include "Auto" option; for others, filter it out
		const allOptions = featureName === 'Chat'
			? settingsState._modelOptions
			: settingsState._modelOptions.filter((o) => !(o.selection.providerName === 'auto' && o.selection.modelName === 'auto'));
		const newOptions = allOptions.filter((o) => filter(o.selection, { chatMode: settingsState.globalSettings.chatMode, overridesOfModel: settingsState.overridesOfModel }));

		if (!optionsEqual(oldOptions, newOptions)) {
			setMemoizedOptions(newOptions);
		}
		oldOptionsRef.current = newOptions;
	}, [settingsState._modelOptions, filter, featureName]);

	if (memoizedOptions.length === 0) { // Pretty sure this will never be reached unless filter is enabled
		return <WarningBox text={emptyMessage?.message || modelDdS.noModels} />;
	}

	return <ModelSelectBox featureName={featureName} options={memoizedOptions} className={className} />;

};

export const ModelDropdown = ({ featureName, className }: { featureName: FeatureName; className: string }) => {
	const settingsState = useSettingsState();

	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');

	const openSettings = () => { commandService.executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID); };


	const { emptyMessage } = modelFilterOfFeatureName[featureName];

	const isDisabled = isFeatureNameDisabled(featureName, settingsState);
	if (isDisabled)
		{return <WarningBox onClick={openSettings} text={
			emptyMessage && emptyMessage.priority === 'always' ? emptyMessage.message :
				isDisabled === 'needToEnableModel' ? modelDdS.enableModel
					: isDisabled === 'addModel' ? modelDdS.addModel
						: (isDisabled === 'addProvider' || isDisabled === 'notFilledIn' || isDisabled === 'providerNotAutoDetected') ? modelDdS.needProvider
							: modelDdS.needProvider
		} />;}

	return <ErrorBoundary>
		<MemoizedModelDropdown featureName={featureName} className={className} />
	</ErrorBoundary>;
};
