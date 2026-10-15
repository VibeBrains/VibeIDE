/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayInfoOfProviderName, FeatureName, featureNames, isFeatureNameDisabled, ModelSelection, modelSelectionsEqual, OverridesOfModel, ProviderName, providerNames, SettingsOfProvider } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsTypes.js';
import { useSettingsState, useRefreshModelState, useAccessor, useChatThreadsState } from '../util/services.js';
import { DropdownBadge, VibeCustomDropdownBox } from '../util/inputs.js';
import { SelectBox } from '../../../../../../../base/browser/ui/selectBox/selectBox.js';
import { IconWarning } from '../sidebar-tsx/SidebarChat.js';
import { VIBEIDE_OPEN_SETTINGS_ACTION_ID, VIBEIDE_TOGGLE_SETTINGS_ACTION_ID } from '../../../vibeideSettingsPane.js';
import { modelFilterOfFeatureName, ModelOption } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsService.js';
import { WarningBox } from './WarningBox.js';
import ErrorBoundary from '../sidebar-tsx/ErrorBoundary.js';
import { modelDdS } from './vibeSettingsRu.js';
import { deprecationTooltip, retirementOfModel } from '../../../../common/modelDeprecationText.js';

/**
 * The marker of a model the vendor is retiring or has retired, or nothing
 * Read at render time, not memoized with the options: the verdict moves with the clock, not with the list
 */
const deprecationBadge = (option: ModelOption, overridesOfModel: OverridesOfModel | undefined): DropdownBadge | undefined => {
	const retirement = retirementOfModel(option.selection, overridesOfModel, Date.now());
	if (!retirement) {
		return undefined;
	}
	const { severity } = retirement.status;
	return {
		glyph: severity === 'retired' ? '⛔' : '⏳',
		tooltip: deprecationTooltip(retirement.status, retirement.date),
		tone: severity === 'retired' ? 'error' : severity === 'soon' ? 'warning' : undefined,
		onTrigger: true,
	};
};

const optionsEqual = (m1: ModelOption[], m2: ModelOption[]) => {
	if (m1.length !== m2.length) {return false;}
	for (let i = 0; i < m1.length; i++) {
		if (!modelSelectionsEqual(m1[i].selection, m2[i].selection)) {return false;}
	}
	return true;
};

/**
 * What the chat's pill can point at: one of the models, or — for the chat only — an external agent
 * An agent is chosen for a thread, not for the whole window: it has its own history, so it cannot be swapped under a conversation
 */
type ChatTarget =
	| { readonly kind: 'model'; readonly option: ModelOption }
	| { readonly kind: 'agent'; readonly agentId: string; readonly agentName: string };

const targetsEqual = (a: ChatTarget, b: ChatTarget): boolean =>
	a.kind === 'model' && b.kind === 'model' ? optionsEqual([a.option], [b.option])
		: a.kind === 'agent' && b.kind === 'agent' ? a.agentId === b.agentId
			: false;

const isAutoOption = (option: ModelOption) => option.selection.providerName === 'auto' && option.selection.modelName === 'auto';

const ModelSelectBox = ({ options, featureName, className }: { options: ModelOption[]; featureName: FeatureName; className: string }) => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const chatThreadService = accessor.get('IChatThreadService');
	const registry = accessor.get('IVibeAcpRegistryService');
	const notificationService = accessor.get('INotificationService');
	const threadsState = useChatThreadsState();

	const [agents, setAgents] = useState(registry.agents);
	useEffect(() => {
		// The registry reads its files after it is created, so what it holds now may be newer than what the state started with
		setAgents(registry.agents);
		const listener = registry.onDidChange(() => setAgents(registry.agents));
		return () => listener.dispose();
	}, [registry]);

	const isChat = featureName === 'Chat';
	const thread = isChat ? threadsState.allThreads[threadsState.currentThreadId] : undefined;
	const leader = thread?.acpAgent;

	// With agents on offer the list reads: Auto, the agents, then the models under a heading of their own
	// The agents go ahead of the models: a list of dozens of models would push them below the fold, where nobody looks
	const hasAgents = isChat && agents.length > 0;
	const targets = useMemo<ChatTarget[]>(() => {
		const models = options.map((option): ChatTarget => ({ kind: 'model', option }));
		if (!hasAgents) { return models; }
		const agentTargets = agents.map((agent): ChatTarget => ({ kind: 'agent', agentId: agent.id, agentName: agent.name ?? agent.id }));
		return [
			...models.filter(target => target.kind === 'model' && isAutoOption(target.option)),
			...agentTargets,
			...models.filter(target => target.kind === 'model' && !isAutoOption(target.option)),
		];
	}, [options, agents, hasAgents]);

	const selection = vibeideSettingsService.state.modelSelectionOfFeature[featureName];
	// Fall back to options[0] when the saved selection isn't found in _modelOptions (stale/removed
	// model). `.find(...)!` previously lied — it could return undefined, which fed VibeCustomDropdownBox
	// an undefined selectedOption and tripped its auto-select loop. `options` is guaranteed non-empty
	// here (MemoizedModelDropdown renders a WarningBox when there are no options).
	const selectedModel = (selection && vibeideSettingsService.state._modelOptions.find(v => modelSelectionsEqual(v.selection, selection))) || options[0];
	// An agent that left the registry still leads its thread; the pill keeps showing it rather than a model it never used
	const selectedTarget: ChatTarget = leader
		? targets.find(target => target.kind === 'agent' && target.agentId === leader.agentId) ?? { kind: 'agent', agentId: leader.agentId, agentName: leader.agentName }
		: { kind: 'model', option: selectedModel };

	const onChangeTarget = useCallback((target: ChatTarget) => {
		// A thread with messages keeps its leader: the agent's history is its own, and a model has none of it
		const locked = !!thread && thread.messages.length > 0;
		if (target.kind === 'agent') {
			if (leader?.agentId === target.agentId) { return; }
			if (!thread || locked || !chatThreadService.setThreadAcpAgent(thread.id, { agentId: target.agentId, agentName: target.agentName })) {
				notificationService.info(modelDdS.leaderLocked);
			}
			return;
		}
		if (leader && (!thread || !chatThreadService.setThreadAcpAgent(thread.id, undefined))) {
			notificationService.info(modelDdS.leaderLocked);
			return;
		}
		vibeideSettingsService.setModelSelectionOfFeature(featureName, target.option.selection);
	}, [vibeideSettingsService, chatThreadService, notificationService, featureName, thread, leader]);

	return <VibeCustomDropdownBox<ChatTarget>
		options={targets}
		selectedOption={selectedTarget}
		onChangeOption={onChangeTarget}
		dropdownQuickSearch={true}
		dropdownSearchPlaceholder={modelDdS.searchModels}
		dropdownSearchEmptyMessage={modelDdS.noModelSearchMatches}
		getOptionDisplayName={(target) => {
			if (target.kind === 'agent') { return target.agentName; }
			// Special display for "Auto" option
			return isAutoOption(target.option) ? modelDdS.auto : target.option.selection.modelName;
		}}
		getOptionDropdownName={(target) => {
			if (target.kind === 'agent') { return target.agentName; }
			return isAutoOption(target.option) ? modelDdS.auto : target.option.selection.modelName;
		}}
		getOptionDropdownDetail={(target) => {
			if (target.kind === 'agent') { return modelDdS.agentDetail; }
			return isAutoOption(target.option) ? modelDdS.autoDetail : displayInfoOfProviderName(target.option.selection.providerName).title;
		}}
		getOptionGroup={(target) => target.kind === 'agent' ? modelDdS.agentsGroup : hasAgents && !isAutoOption(target.option) ? modelDdS.modelsGroup : undefined}
		getOptionBadges={(target) => {
			if (target.kind === 'agent') { return []; }
			const option = target.option;
			// Dynamic-provider models flag their provenance with a trailing "✎" — the pencil's tooltip
			// tells the user the model / its caps come from .vibe/providers.json, not the live catalog.
			const fileNote = option.fileNote === 'override' ? modelDdS.fileNoteOverride
				: option.fileNote === 'manual' ? modelDdS.fileNoteManual
					: undefined;
			const badges: DropdownBadge[] = [];
			const retirement = deprecationBadge(option, vibeideSettingsService.state.overridesOfModel);
			if (retirement) {
				badges.push(retirement);
			}
			if (fileNote) {
				badges.push({ glyph: '✎', tooltip: fileNote });
			}
			return badges;
		}}
		getOptionsEqual={targetsEqual}
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
