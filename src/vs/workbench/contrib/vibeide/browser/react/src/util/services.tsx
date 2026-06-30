/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useState, useEffect, useCallback } from 'react';
import { MCPUserState, RefreshableProviderName, SettingsOfProvider } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsTypes.js';
import { DisposableStore, IDisposable } from '../../../../../../../base/common/lifecycle.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../../../../../../../workbench/contrib/vibeide/common/vibeideSettingsService.js';
import { ColorScheme } from '../../../../../../../platform/theme/common/theme.js';
import { IRefreshModelService, RefreshModelStateOfProvider } from '../../../../../../../workbench/contrib/vibeide/common/refreshModelService.js';

import { ServicesAccessor } from '../../../../../../../editor/browser/editorExtensions.js';
import { IExplorerService } from '../../../../../../../workbench/contrib/files/browser/files.js';
import { IWorkbenchLayoutService } from '../../../../../../../workbench/services/layout/browser/layoutService.js';
import { IModelService } from '../../../../../../../editor/common/services/model.js';
import { IClipboardService } from '../../../../../../../platform/clipboard/common/clipboardService.js';
import { IContextViewService, IContextMenuService } from '../../../../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../../../../platform/hover/browser/hover.js';
import { IThemeService } from '../../../../../../../platform/theme/common/themeService.js';
import { ILLMMessageService } from '../../../../common/sendLLMMessageService.js';
import { IExtensionTransferService } from '../../../../../../../workbench/contrib/vibeide/browser/extensionTransferService.js';

import { IInstantiationService } from '../../../../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../../../../editor/browser/services/codeEditorService.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../../../../platform/notification/common/notification.js';
import { IAccessibilityService } from '../../../../../../../platform/accessibility/common/accessibility.js';
import { ILanguageConfigurationService } from '../../../../../../../editor/common/languages/languageConfigurationRegistry.js';
import { ILanguageFeaturesService } from '../../../../../../../editor/common/services/languageFeatures.js';
import { ILanguageDetectionService } from '../../../../../../services/languageDetection/common/languageDetectionWorkerService.js';
import { IKeybindingService } from '../../../../../../../platform/keybinding/common/keybinding.js';
import { IEnvironmentService } from '../../../../../../../platform/environment/common/environment.js';
import { IConfigurationService } from '../../../../../../../platform/configuration/common/configuration.js';
import { IPathService } from '../../../../../../../workbench/services/path/common/pathService.js';
import { IMetricsService } from '../../../../../../../workbench/contrib/vibeide/common/metricsService.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { IChatThreadService, ThreadsState, ThreadStreamState } from '../../../chatThreadService.js';
import { ITerminalToolService } from '../../../terminalToolService.js';
import { ILanguageService } from '../../../../../../../editor/common/languages/language.js';
import { IVibeideModelService } from '../../../../common/vibeideModelService.js';
import { IWorkspaceContextService } from '../../../../../../../platform/workspace/common/workspace.js';
import { IVibeideCommandBarService } from '../../../vibeideCommandBarService.js';
import { INativeHostService } from '../../../../../../../platform/native/common/native.js';
import { IEditCodeService } from '../../../editCodeServiceInterface.js';
import { IToolsService } from '../../../toolsService.js';
import { IConvertToLLMMessageService } from '../../../convertToLLMMessageService.js';
import { ITerminalService } from '../../../../../terminal/browser/terminal.js';
import { ISearchService } from '../../../../../../services/search/common/search.js';
import { IExtensionManagementService } from '../../../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IMCPService } from '../../../../common/mcpService.js';
import { IStorageService, StorageScope } from '../../../../../../../platform/storage/common/storage.js';
import { OPT_OUT_KEY } from '../../../../common/storageKeys.js';
import { IRepoIndexerService } from '../../../repoIndexerService.js';
import { ISecretDetectionService } from '../../../../common/secretDetectionService.js';
import { IVibeModelsRegistryService } from '../../../../common/vibeModelsRegistryService.js';
import { IVibeWorkspaceFormsService } from '../../../vibeWorkspaceFormsService.js';
import { IVibeSessionMemoryService } from '../../../../common/vibeSessionMemoryService.js';
import { IVibePerfGuardrailsService } from '../../../vibePerfGuardrailsService.js';
import { IVibeProjectRulesService } from '../../../vibeProjectRulesService.js';
import { IVibeCustomCommandsService } from '../../../vibeCustomCommandsService.js';
import { IVibeTokenBudgetService } from '../../../../common/vibeTokenBudgetService.js';
import { IVibeContextGuardService } from '../../../vibeContextGuardService.js';
import { IRemoteCatalogService } from '../../../../common/remoteCatalogService.js';
import { IVibeSlashCommandService } from '../../../../common/vibeSlashCommandService.js';
import { IVibeSkillsLibraryService } from '../../../../common/vibeSkillsLibraryService.js';
import { IVibeModalService } from '../../../../common/vibeModalService.js';
import { IVibeCommandsPaletteService } from '../../../../common/vibeCommandsPaletteService.js';
import { IVibeProjectCommandFormModalService } from '../../../../common/vibeProjectCommandFormModalService.js';
import { IVibeProviderDiagnosticsService } from '../../../../common/vibeProviderDiagnosticsService.js';
import { IVibeDynamicProvidersService } from '../../../vibeDynamicProvidersService.js';
import { IVibeNotifySoundService } from '../../../vibeNotifySoundService.js';
import { IVibeNotifySoundsModalService } from '../../../../common/vibeNotifySoundsModalService.js';
import { IEditorService } from '../../../../../../../workbench/services/editor/common/editorService.js';


// normally to do this you'd use a useEffect that calls .onDidChangeState(), but useEffect mounts too late and misses initial state changes

// even if React hasn't mounted yet, the variables are always updated to the latest state.
// React listens by adding a setState function to these listeners.

let chatThreadsState: ThreadsState;
const chatThreadsStateListeners: Set<(s: ThreadsState) => void> = new Set();

let chatThreadsStreamState: ThreadStreamState;
const chatThreadsStreamStateListeners: Set<(threadId: string) => void> = new Set();

let settingsState: VibeideSettingsState;
const settingsStateListeners: Set<(s: VibeideSettingsState) => void> = new Set();

let refreshModelState: RefreshModelStateOfProvider;
const refreshModelStateListeners: Set<(s: RefreshModelStateOfProvider) => void> = new Set();
const refreshModelProviderListeners: Set<(p: RefreshableProviderName, s: RefreshModelStateOfProvider) => void> = new Set();

// Default to LIGHT so useIsDark() is never undefined before _registerServices runs
let colorThemeState: ColorScheme = ColorScheme.LIGHT;
const colorThemeStateListeners: Set<(s: ColorScheme) => void> = new Set();

const ctrlKZoneStreamingStateListeners: Set<(diffareaid: number, s: boolean) => void> = new Set();
const commandBarURIStateListeners: Set<(uri: URI) => void> = new Set();
const activeURIListeners: Set<(uri: URI | null) => void> = new Set();

const mcpListeners: Set<() => void> = new Set();


// must call this before you can use any of the hooks below
// this is called ONCE PER BUNDLE — each tsup entry (sidebar-tsx, modal-tsx,
// quick-edit-tsx, ...) has its own module-scoped state vars (chatThreadsState,
// settingsState, etc) that must each be initialized. Multiple invocations
// across bundles are EXPECTED and CORRECT — they're not «duplicate
// subscriptions», they're per-bundle setup.
//
// (Earlier audit Z.12.2 tried to guard this idempotently — that was wrong:
// the guard blocked bundle 2+ state-var init, so `useSettingsState()` returned
// undefined and `<VibeOnboarding>` crashed reading `state.globalSettings`.
// Reverted to the pre-Z.12.2 behavior. The Z.12.2 hypothesis about subscription
// leak was a misdiagnosis — bundle-local subscriptions are correct.)
export const _registerServices = (accessor: ServicesAccessor) => {

	const disposables: IDisposable[] = [];

	_registerAccessor(accessor);

	const stateServices = {
		chatThreadsStateService: accessor.get(IChatThreadService),
		settingsStateService: accessor.get(IVibeideSettingsService),
		refreshModelService: accessor.get(IRefreshModelService),
		themeService: accessor.get(IThemeService),
		editCodeService: accessor.get(IEditCodeService),
		vibeideCommandBarService: accessor.get(IVibeideCommandBarService),
		modelService: accessor.get(IModelService),
		mcpService: accessor.get(IMCPService),
	};

	const { settingsStateService, chatThreadsStateService, refreshModelService, themeService, editCodeService, vibeideCommandBarService, modelService, mcpService } = stateServices;




	chatThreadsState = chatThreadsStateService.state;
	disposables.push(
		chatThreadsStateService.onDidChangeCurrentThread(() => {
			chatThreadsState = chatThreadsStateService.state;
			chatThreadsStateListeners.forEach(l => l(chatThreadsState));
		})
	);

	// same service, different state
	chatThreadsStreamState = chatThreadsStateService.streamState;
	disposables.push(
		chatThreadsStateService.onDidChangeStreamState(({ threadId }) => {
			chatThreadsStreamState = chatThreadsStateService.streamState;
			chatThreadsStreamStateListeners.forEach(l => l(threadId));
		})
	);

	settingsState = settingsStateService.state;
	disposables.push(
		settingsStateService.onDidChangeState(() => {
			settingsState = settingsStateService.state;
			settingsStateListeners.forEach(l => l(settingsState));
		})
	);

	refreshModelState = refreshModelService.state;
	disposables.push(
		refreshModelService.onDidChangeState((providerName) => {
			refreshModelState = refreshModelService.state;
			refreshModelStateListeners.forEach(l => l(refreshModelState));
			refreshModelProviderListeners.forEach(l => l(providerName, refreshModelState)); // no state
		})
	);

	colorThemeState = themeService.getColorTheme().type;
	// Notify any already-mounted components so they get correct initial theme
	colorThemeStateListeners.forEach(l => l(colorThemeState));
	disposables.push(
		themeService.onDidColorThemeChange(({ type }) => {
			colorThemeState = type;
			// Defer to next frame so we don't call React setState during theme application (avoids "update while rendering" when switching theme)
			requestAnimationFrame(() => {
				colorThemeStateListeners.forEach(l => l(colorThemeState));
			});
		})
	);

	// no state
	disposables.push(
		editCodeService.onDidChangeStreamingInCtrlKZone(({ diffareaid }) => {
			const isStreaming = editCodeService.isCtrlKZoneStreaming({ diffareaid });
			ctrlKZoneStreamingStateListeners.forEach(l => l(diffareaid, isStreaming));
		})
	);

	disposables.push(
		vibeideCommandBarService.onDidChangeState(({ uri }) => {
			commandBarURIStateListeners.forEach(l => l(uri));
		})
	);

	disposables.push(
		vibeideCommandBarService.onDidChangeActiveURI(({ uri }) => {
			activeURIListeners.forEach(l => l(uri));
		})
	);

	disposables.push(
		mcpService.onDidChangeState(() => {
			mcpListeners.forEach(l => l());
		})
	);


	return disposables;
};



const getReactAccessor = (accessor: ServicesAccessor) => {
	// Extract all services synchronously in a single pass
	// This must complete before the accessor becomes invalid
	// (which happens when invokeFunction returns)
	try {
		const reactAccessor = {
			IModelService: accessor.get(IModelService),
			IClipboardService: accessor.get(IClipboardService),
			IContextViewService: accessor.get(IContextViewService),
			IContextMenuService: accessor.get(IContextMenuService),
			IFileService: accessor.get(IFileService),
			IFileDialogService: accessor.get(IFileDialogService),
			IHoverService: accessor.get(IHoverService),
			IThemeService: accessor.get(IThemeService),
			ILLMMessageService: accessor.get(ILLMMessageService),
			IRefreshModelService: accessor.get(IRefreshModelService),
			IVibeideSettingsService: accessor.get(IVibeideSettingsService),
			IEditCodeService: accessor.get(IEditCodeService),
			IChatThreadService: accessor.get(IChatThreadService),

			IInstantiationService: accessor.get(IInstantiationService),
			ICodeEditorService: accessor.get(ICodeEditorService),
			ICommandService: accessor.get(ICommandService),
			IContextKeyService: accessor.get(IContextKeyService),
			INotificationService: accessor.get(INotificationService),
			IAccessibilityService: accessor.get(IAccessibilityService),
			ILanguageConfigurationService: accessor.get(ILanguageConfigurationService),
			ILanguageDetectionService: accessor.get(ILanguageDetectionService),
			ILanguageFeaturesService: accessor.get(ILanguageFeaturesService),
			IKeybindingService: accessor.get(IKeybindingService),
			ISearchService: accessor.get(ISearchService),

			IExplorerService: accessor.get(IExplorerService),
			IWorkbenchLayoutService: accessor.get(IWorkbenchLayoutService),
			IEnvironmentService: accessor.get(IEnvironmentService),
			IConfigurationService: accessor.get(IConfigurationService),
			IPathService: accessor.get(IPathService),
			IMetricsService: accessor.get(IMetricsService),
			ITerminalToolService: accessor.get(ITerminalToolService),
			ILanguageService: accessor.get(ILanguageService),
			IVibeideModelService: accessor.get(IVibeideModelService),
			IWorkspaceContextService: accessor.get(IWorkspaceContextService),

			IVibeideCommandBarService: accessor.get(IVibeideCommandBarService),
			INativeHostService: accessor.get(INativeHostService),
			IToolsService: accessor.get(IToolsService),
			IConvertToLLMMessageService: accessor.get(IConvertToLLMMessageService),
			ITerminalService: accessor.get(ITerminalService),
			IExtensionManagementService: accessor.get(IExtensionManagementService),
			IExtensionTransferService: accessor.get(IExtensionTransferService),
			IMCPService: accessor.get(IMCPService),
			IRepoIndexerService: accessor.get(IRepoIndexerService),
			ISecretDetectionService: accessor.get(ISecretDetectionService),
			IVibeModelsRegistryService: accessor.get(IVibeModelsRegistryService),
			IVibeWorkspaceFormsService: accessor.get(IVibeWorkspaceFormsService),

			IStorageService: accessor.get(IStorageService),

			IVibeSessionMemoryService: accessor.get(IVibeSessionMemoryService),
			IVibeProjectRulesService: accessor.get(IVibeProjectRulesService),
			IVibePerfGuardrailsService: accessor.get(IVibePerfGuardrailsService),
			IVibeCustomCommandsService: accessor.get(IVibeCustomCommandsService),

			IVibeTokenBudgetService: accessor.get(IVibeTokenBudgetService),
			IVibeContextGuardService: accessor.get(IVibeContextGuardService),
			IRemoteCatalogService: accessor.get(IRemoteCatalogService),

			IVibeSlashCommandService: accessor.get(IVibeSlashCommandService),
			IVibeSkillsLibraryService: accessor.get(IVibeSkillsLibraryService),
			IVibeModalService: accessor.get(IVibeModalService),
			IVibeCommandsPaletteService: accessor.get(IVibeCommandsPaletteService),
			IVibeProjectCommandFormModalService: accessor.get(IVibeProjectCommandFormModalService),
			IVibeProviderDiagnosticsService: accessor.get(IVibeProviderDiagnosticsService),
			IVibeDynamicProvidersService: accessor.get(IVibeDynamicProvidersService),
			IVibeNotifySoundService: accessor.get(IVibeNotifySoundService),
			IVibeNotifySoundsModalService: accessor.get(IVibeNotifySoundsModalService),
			IEditorService: accessor.get(IEditorService),

		} as const;
		return reactAccessor;
	} catch (error) {
		vibeLog.error('services', '[ReactServices] Failed to extract services from accessor:', error);
		throw error;
	}
};

type ReactAccessor = ReturnType<typeof getReactAccessor>;


let reactAccessor_: ReactAccessor | null = null;
const _registerAccessor = (accessor: ServicesAccessor) => {
	const reactAccessor = getReactAccessor(accessor);
	reactAccessor_ = reactAccessor;
};


// -- services --
// Stable singleton API. `reactAccessor_` is a module-level singleton, so `get` can resolve it lazily
// at call time and the returned object identity never changes. Returning a fresh `{ get }` per call
// (the old behaviour) made every `useEffect(..., [accessor])` re-run on EVERY render — and any such
// effect that setState'd (e.g. the skills loader's async setSkillCmds([...])) became an infinite
// microtask-driven re-render loop that froze the renderer ("Окно не отвечает").
const _accessorApi = { get: <S extends keyof ReactAccessor,>(service: S): ReactAccessor[S] => reactAccessor_![service] };
export const useAccessor = () => {
	if (!reactAccessor_) {
		throw new Error(`⚠️ VibeIDE useAccessor was called before _registerServices!`);
	}

	return _accessorApi;
};



// -- state of services --

export const useSettingsState = () => {
	const [s, ss] = useState(settingsState);
	useEffect(() => {
		ss(settingsState);
		settingsStateListeners.add(ss);
		return () => { settingsStateListeners.delete(ss); };
	}, [ss]);
	return s;
};

export const useChatThreadsState = () => {
	const [s, ss] = useState(chatThreadsState);
	useEffect(() => {
		ss(chatThreadsState);
		chatThreadsStateListeners.add(ss);
		return () => { chatThreadsStateListeners.delete(ss); };
	}, [ss]);
	return s;
	// allow user to set state natively in react
	// const ss: React.Dispatch<React.SetStateAction<ThreadsState>> = (action)=>{
	// 	_ss(action)
	// 	if (typeof action === 'function') {
	// 		const newState = action(chatThreadsState)
	// 		chatThreadsState = newState
	// 	} else {
	// 		chatThreadsState = action
	// 	}
	// }
	// return [s, ss] as const
};




export const useChatThreadsStreamState = (threadId: string) => {
	const [s, ss] = useState<ThreadStreamState[string] | undefined>(chatThreadsStreamState[threadId]);
	useEffect(() => {
		ss(chatThreadsStreamState[threadId]);
		const listener = (threadId_: string) => {
			if (threadId_ !== threadId) {return;}
			ss(chatThreadsStreamState[threadId]);
		};
		chatThreadsStreamStateListeners.add(listener);
		return () => { chatThreadsStreamStateListeners.delete(listener); };
	}, [ss, threadId]);
	return s;
};

export const useFullChatThreadsStreamState = () => {
	const [s, ss] = useState(chatThreadsStreamState);
	useEffect(() => {
		ss(chatThreadsStreamState);
		const listener = () => { ss(chatThreadsStreamState); };
		chatThreadsStreamStateListeners.add(listener);
		return () => { chatThreadsStreamStateListeners.delete(listener); };
	}, [ss]);
	return s;
};



export const useRefreshModelState = () => {
	const [s, ss] = useState(refreshModelState);
	useEffect(() => {
		ss(refreshModelState);
		refreshModelStateListeners.add(ss);
		return () => { refreshModelStateListeners.delete(ss); };
	}, [ss]);
	return s;
};


export const useRefreshModelListener = (listener: (providerName: RefreshableProviderName, s: RefreshModelStateOfProvider) => void) => {
	useEffect(() => {
		refreshModelProviderListeners.add(listener);
		return () => { refreshModelProviderListeners.delete(listener); };
	}, [listener, refreshModelProviderListeners]);
};

export const useCtrlKZoneStreamingState = (listener: (diffareaid: number, s: boolean) => void) => {
	useEffect(() => {
		ctrlKZoneStreamingStateListeners.add(listener);
		return () => { ctrlKZoneStreamingStateListeners.delete(listener); };
	}, [listener, ctrlKZoneStreamingStateListeners]);
};

export const useIsDark = () => {
	const [s, ss] = useState(colorThemeState);
	useEffect(() => {
		ss(colorThemeState);
		colorThemeStateListeners.add(ss);
		return () => { colorThemeStateListeners.delete(ss); };
	}, [ss]);

	// s is the theme, return isDark instead of s
	const isDark = s === ColorScheme.DARK || s === ColorScheme.HIGH_CONTRAST_DARK;
	return isDark;
};

export const useCommandBarURIListener = (listener: (uri: URI) => void) => {
	useEffect(() => {
		commandBarURIStateListeners.add(listener);
		return () => { commandBarURIStateListeners.delete(listener); };
	}, [listener]);
};
export const useCommandBarState = () => {
	const accessor = useAccessor();
	const commandBarService = accessor.get('IVibeideCommandBarService');
	const [s, ss] = useState({ stateOfURI: commandBarService.stateOfURI, sortedURIs: commandBarService.sortedURIs });
	const listener = useCallback(() => {
		ss({ stateOfURI: commandBarService.stateOfURI, sortedURIs: commandBarService.sortedURIs });
	}, [commandBarService]);
	useCommandBarURIListener(listener);

	return s;
};



// roughly gets the active URI - this is used to get the history of recent URIs
export const useActiveURI = () => {
	const accessor = useAccessor();
	const commandBarService = accessor.get('IVibeideCommandBarService');
	const [s, ss] = useState(commandBarService.activeURI);
	useEffect(() => {
		const listener = () => { ss(commandBarService.activeURI); };
		activeURIListeners.add(listener);
		return () => { activeURIListeners.delete(listener); };
	}, []);
	return { uri: s };
};




export const useMCPServiceState = () => {
	const accessor = useAccessor();
	const mcpService = accessor.get('IMCPService');
	const [s, ss] = useState(mcpService.state);
	useEffect(() => {
		const listener = () => { ss(mcpService.state); };
		mcpListeners.add(listener);
		return () => { mcpListeners.delete(listener); };
	}, []);
	return s;
};



export const useIsOptedOut = () => {
	const accessor = useAccessor();
	const storageService = accessor.get('IStorageService');

	const getVal = useCallback(() => {
		return storageService.getBoolean(OPT_OUT_KEY, StorageScope.APPLICATION, false);
	}, [storageService]);

	const [s, ss] = useState(getVal());

	useEffect(() => {
		const disposables = new DisposableStore();
		const d = storageService.onDidChangeValue(StorageScope.APPLICATION, OPT_OUT_KEY, disposables)(e => {
			ss(getVal());
		});
		disposables.add(d);
		return () => disposables.clear();
	}, [storageService, getVal]);

	return s;
};
