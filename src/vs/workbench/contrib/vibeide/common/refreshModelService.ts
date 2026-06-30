/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IRemoteCatalogService } from './remoteCatalogService.js';
import type { ModelOverrides } from './modelCapabilities.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { RefreshableProviderName, refreshableProviderNames, SettingsOfProvider, ProviderName } from './vibeideSettingsTypes.js';
import { OllamaModelResponse, OpenaiCompatibleModelResponse } from './sendLLMMessageTypes.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';




type TimerHandle = ReturnType<typeof setTimeout>;

type RefreshableState = ({
	state: 'init';
	timeoutId: null;
} | {
	state: 'refreshing';
	timeoutId: TimerHandle | null; // the timeoutId of the most recent call to refreshModels
} | {
	state: 'finished';
	timeoutId: null;
} | {
	state: 'error';
	timeoutId: null;
});


/*

user click -> error -> fire(error)
		   \> success -> fire(success)
	finally: keep polling

poll -> do not fire

*/
export type RefreshModelStateOfProvider = Record<RefreshableProviderName, RefreshableState>;



const refreshBasedOn: { [k in RefreshableProviderName]: (keyof SettingsOfProvider[k])[] } = {
	ollama: ['_didFillInProviderSettings', 'endpoint'],
	vLLM: ['_didFillInProviderSettings', 'endpoint'],
	lmStudio: ['_didFillInProviderSettings', 'endpoint'],
	// openAICompatible: ['_didFillInProviderSettings', 'endpoint', 'apiKey'],
};
const REFRESH_INTERVAL = 5_000;
// const COOLDOWN_TIMEOUT = 300

const autoOptions = { enableProviderOnSuccess: true, doNotFire: true };

// element-wise equals
function eq<T>(a: T[], b: T[]): boolean {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) { return false; }
	}
	return true;
}
export interface IRefreshModelService {
	readonly _serviceBrand: undefined;
	startRefreshingModels: (providerName: RefreshableProviderName, options: { enableProviderOnSuccess: boolean; doNotFire: boolean }) => void;
	refreshRemoteCatalog: (providerName: ProviderName, forceRefresh?: boolean) => Promise<void>;
	onDidChangeState: Event<RefreshableProviderName>;
	state: RefreshModelStateOfProvider;
}

export const IRefreshModelService = createDecorator<IRefreshModelService>('RefreshModelService');

export class RefreshModelService extends Disposable implements IRefreshModelService {

	readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<RefreshableProviderName>();
	readonly onDidChangeState: Event<RefreshableProviderName> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes


	constructor(
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IRemoteCatalogService private readonly remoteCatalogService: IRemoteCatalogService,
	) {
		super();


		const disposables: Set<IDisposable> = new Set();

		const initializeAutoPollingAndOnChange = () => {
			this._clearAllTimeouts();
			disposables.forEach(d => d.dispose());
			disposables.clear();

			if (!vibeideSettingsService.state.globalSettings.autoRefreshModels) { return; }

			for (const providerName of refreshableProviderNames) {

				// const { '_didFillInProviderSettings': enabled } = this.vibeideSettingsService.state.settingsOfProvider[providerName]
				this.startRefreshingModels(providerName, autoOptions);

				// every time providerName.enabled changes, refresh models too, like a useEffect
				const relevantVals = () => refreshBasedOn[providerName].map(settingName => vibeideSettingsService.state.settingsOfProvider[providerName][settingName]);
				let prevVals = relevantVals(); // each iteration of a for loop has its own context and vars, so this is ok
				disposables.add(
					vibeideSettingsService.onDidChangeState(() => { // we might want to debounce this
						const newVals = relevantVals();
						if (!eq(prevVals, newVals)) {

							const prevEnabled = prevVals[0] as boolean;
							const enabled = newVals[0] as boolean;

							// if it was just enabled, or there was a change and it wasn't to the enabled state, refresh
							if ((enabled && !prevEnabled) || (!enabled && !prevEnabled)) {
								// if user just clicked enable, refresh
								this.startRefreshingModels(providerName, autoOptions);
							}
							else {
								// else if user just clicked disable, don't refresh

								// //give cooldown before re-enabling (or at least re-fetching)
								// const timeoutId = setTimeout(() => this.refreshModels(providerName, !enabled), COOLDOWN_TIMEOUT)
								// this._setTimeoutId(providerName, timeoutId)
							}
							prevVals = newVals;
						}
					})
				);
			}
		};

		// on mount (when get init settings state), and if a relevant feature flag changes, start refreshing models
		vibeideSettingsService.waitForInitState.then(() => {
			initializeAutoPollingAndOnChange();
			this._register(
				vibeideSettingsService.onDidChangeState((type) => { if (typeof type === 'object' && type[1] === 'autoRefreshModels') { initializeAutoPollingAndOnChange(); } })
			);
		});

	}

	state: RefreshModelStateOfProvider = {
		ollama: { state: 'init', timeoutId: null },
		vLLM: { state: 'init', timeoutId: null },
		lmStudio: { state: 'init', timeoutId: null },
	};


	// start listening for models (and don't stop)
	startRefreshingModels: IRefreshModelService['startRefreshingModels'] = (providerName, options) => {

		this._clearProviderTimeout(providerName);

		this._setRefreshState(providerName, 'refreshing', options);

		const autoPoll = () => {
			if (this.vibeideSettingsService.state.globalSettings.autoRefreshModels) {
				// resume auto-polling
				const timeoutId = setTimeout(() => this.startRefreshingModels(providerName, autoOptions), REFRESH_INTERVAL);
				this._setTimeoutId(providerName, timeoutId);
			}
		};
		const listFn = providerName === 'ollama' ? this.llmMessageService.ollamaList
			: this.llmMessageService.openAICompatibleList;

		listFn({
			providerName,
			onSuccess: async ({ models }) => {
				// set the models to the detected models
				await this.vibeideSettingsService.setAutodetectedModels(
					providerName,
					models.map(model => {
						if (providerName === 'ollama') { return (model as OllamaModelResponse).name; }
						else if (providerName === 'vLLM') { return (model as OpenaiCompatibleModelResponse).id; }
						else if (providerName === 'lmStudio') { return (model as OpenaiCompatibleModelResponse).id; }
						else { throw new Error('refreshMode fn: unknown provider', providerName); }
					}),
					{ enableProviderOnSuccess: options.enableProviderOnSuccess, hideRefresh: options.doNotFire, defaultHiddenForNew: false }
				);

				if (options.enableProviderOnSuccess) { this.vibeideSettingsService.setSettingOfProvider(providerName, '_didFillInProviderSettings', true); }

				this._setRefreshState(providerName, 'finished', options);
				autoPoll();
			},
			onError: ({ error }) => {
				this._setRefreshState(providerName, 'error', options);
				autoPoll();
			}
		});


	};

	_clearAllTimeouts() {
		for (const providerName of refreshableProviderNames) {
			this._clearProviderTimeout(providerName);
		}
	}

	_clearProviderTimeout(providerName: RefreshableProviderName) {
		// cancel any existing poll
		if (this.state[providerName].timeoutId) {
			clearTimeout(this.state[providerName].timeoutId);
			this._setTimeoutId(providerName, null);
		}
	}

	private _setTimeoutId(providerName: RefreshableProviderName, timeoutId: TimerHandle | null) {
		this.state[providerName].timeoutId = timeoutId;
	}

	private _setRefreshState(providerName: RefreshableProviderName, state: RefreshableState['state'], options?: { doNotFire: boolean }) {
		if (options?.doNotFire) { return; }
		this.state[providerName].state = state;
		this._onDidChangeState.fire(providerName);
	}

	/**
	 * Refresh remote provider catalog and update available models
	 */
	refreshRemoteCatalog: IRefreshModelService['refreshRemoteCatalog'] = async (providerName, forceRefresh = false) => {
		// Only refresh remote providers (not local ones like ollama, vLLM, lmStudio)
		if (refreshableProviderNames.includes(providerName as RefreshableProviderName)) {
			// Local providers use startRefreshingModels instead
			return;
		}

		try {
			if (forceRefresh) {
				this.remoteCatalogService.clearCache(providerName);
			}
			const models = await this.remoteCatalogService.fetchCatalog(providerName, forceRefresh);

			// Convert RemoteModelInfo to model names and add to settings
			const modelNames = models
				.filter(m => !m.deprecated)
				.map(m => m.id || m.name);

			if (modelNames.length > 0) {
				await this.vibeideSettingsService.setAutodetectedModels(
					providerName,
					modelNames,
					{ source: 'remoteCatalog', forceRefresh, defaultHiddenForNew: true }
				);
			}

			const overrideUpdates: Record<string, Partial<ModelOverrides>> = {};
			for (const m of models) {
				if (m.deprecated) { continue; }
				const id = m.id || m.name;
				if (!id) { continue; }
				const partial: Partial<ModelOverrides> = {};
				if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
					partial.contextWindow = m.contextWindow;
				}
				// Catalog-driven vision capability — overrides provider heuristics for aggregators (OpenRouter etc.)
				if (typeof m.supportsVision === 'boolean') {
					partial.supportsVision = m.supportsVision;
				}
				// Display-only modality literal (e.g. "text+image->text") surfaced in the model list UI.
				if (typeof m.modality === 'string' && m.modality.length > 0) {
					partial.modality = m.modality;
				}
				if (Object.keys(partial).length) {
					overrideUpdates[id] = partial;
				}
			}
			if (Object.keys(overrideUpdates).length > 0) {
				await this.vibeideSettingsService.mergeOverridesForProviderModels(providerName, overrideUpdates);
			}
			if (modelNames.length > 0) {
				await this.vibeideSettingsService.pruneOverridesToProviderModels(providerName);
			}
		} catch (error) {
			vibeLog.error('refreshModel', `Failed to refresh remote catalog for ${providerName}:`, error);
			throw error;
		}
	};
}

registerSingleton(IRefreshModelService, RefreshModelService, InstantiationType.Eager);

