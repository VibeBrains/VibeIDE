/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IMetricsService } from './metricsService.js';
import { defaultProviderSettings, getModelCapabilities, ModelOverrides, VibeideStaticModelInfo } from './modelCapabilities.js';
import { VOID_SETTINGS_STORAGE_KEY } from './storageKeys.js';
import { autoModelFallbackProviderOrder, defaultSettingsOfProvider, FeatureName, ProviderName, ModelSelectionOfFeature, SettingsOfProvider, SettingName, providerNames, ModelSelection, modelSelectionsEqual, featureNames, VibeideStatefulModelInfo, GlobalSettings, GlobalSettingName, defaultGlobalSettings, ModelSelectionOptions, OptionsOfModelSelection, ChatMode, OverridesOfModel, defaultOverridesOfModel, MCPUserStateOfName as MCPUserStateOfName, MCPUserState } from './vibeideSettingsTypes.js';


// name is the name in the dropdown
export type ModelOption = {
	name: string;
	selection: ModelSelection;
	/** Provenance marker for DYNAMIC-provider models (.vibe/providers.json), surfaced in the picker so
	 *  the user knows when caps were customized in their file. `'override'` = present in the live catalog
	 *  AND patched by a same-id `static` entry (caps may differ from the provider's defaults); `'manual'`
	 *  = defined only in the file (not returned by the catalog). Absent = plain catalog / built-in. */
	fileNote?: 'override' | 'manual';
};



type SetSettingOfProviderFn = <S extends SettingName>(
	providerName: ProviderName,
	settingName: S,
	newVal: SettingsOfProvider[ProviderName][S extends keyof SettingsOfProvider[ProviderName] ? S : never],
) => Promise<void>;

type SetModelSelectionOfFeatureFn = <K extends FeatureName>(
	featureName: K,
	newVal: ModelSelectionOfFeature[K],
) => Promise<void>;

type SetGlobalSettingFn = <T extends GlobalSettingName>(settingName: T, newVal: GlobalSettings[T]) => void;

type SetOptionsOfModelSelection = (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => void;

/** Recursively strips `readonly` so the one-time settings-blob migration can mutate in place. */
type DeepWritable<T> = T extends ReadonlyArray<infer E>
	? Array<DeepWritable<E>>
	: T extends object
	? { -readonly [K in keyof T]: DeepWritable<T[K]> }
	: T;

/** Stateful model row as stored by older builds — carries pre-1.2.5 boolean flags that the migration
 *  loop folds into the current `type` discriminator. */
type LegacyStatefulModelInfo = DeepWritable<VibeideStatefulModelInfo> & {
	isAutodetected?: boolean;
	isDefault?: boolean;
};

/** Per-provider settings as stored by older builds (legacy `headersJSON`, legacy model flags, and the
 *  pre-1.2.4 `openCode` provider id). */
type LegacyProviderSettings = {
	_didFillInProviderSettings?: boolean;
	headersJSON?: string;
	models: LegacyStatefulModelInfo[];
};

/** Global settings as stored by older builds — `autoApprove` could be a boolean before 1.2.5. */
type LegacyGlobalSettings = DeepWritable<Omit<GlobalSettings, 'autoApprove'>> & {
	autoApprove: GlobalSettings['autoApprove'] | boolean;
};

/** Mutable, legacy-augmented view of a persisted settings blob, used only during the one-time
 *  migration in `readAndInitializeState`. Fields absent from the live types (e.g. a boolean
 *  `autoApprove`, the `openCode` provider key) are reachable here without resorting to `any`. */
type LegacyMigrationState = {
	settingsOfProvider: Record<string, LegacyProviderSettings>;
	modelSelectionOfFeature: DeepWritable<ModelSelectionOfFeature>;
	optionsOfModelSelection: DeepWritable<OptionsOfModelSelection>;
	globalSettings: LegacyGlobalSettings;
};


export type VibeideSettingsState = {
	readonly settingsOfProvider: SettingsOfProvider; // optionsOfProvider
	readonly modelSelectionOfFeature: ModelSelectionOfFeature; // stateOfFeature
	readonly optionsOfModelSelection: OptionsOfModelSelection;
	readonly overridesOfModel: OverridesOfModel;
	readonly globalSettings: GlobalSettings;
	readonly mcpUserStateOfName: MCPUserStateOfName; // user-controlled state of MCP servers

	/** API keys typed into the Settings UI for DYNAMIC providers (.vibe/providers.json), keyed by file
	 *  id. Persisted here (the file is the connection source-of-truth, so the key can't live in the
	 *  file); the dynamic-providers service folds these back into key resolution + the seeded entry. */
	readonly dynamicProviderApiKeys?: Record<string, string>;

	/** Per-model hide toggles for DYNAMIC providers, keyed by provider id then model id. Explicit user
	 *  overrides of the default (file `static` models default shown; catalog-only models default hidden).
	 *  Persisted; applied by the dynamic-providers service to gate the chat picker. */
	readonly dynamicModelHidden?: Record<string, Record<string, boolean>>;

	readonly _modelOptions: ModelOption[]; // computed based on the two above items
};

// type RealVoidSettings = Exclude<keyof VibeideSettingsState, '_modelOptions'>
// type EventProp<T extends RealVoidSettings = RealVoidSettings> = T extends 'globalSettings' ? [T, keyof VibeideSettingsState[T]] : T | 'all'


/** Passed to setAutodetectedModels; for `source === 'remoteCatalog'` new ids default to hidden unless `defaultHiddenForNew: false`. */
export type AutodetectModelsLogging = {
	defaultHiddenForNew?: boolean;
	/** Merge path from RefreshModelService / remote catalogs (OpenRouter, OpenCode, …). */
	source?: 'remoteCatalog';
} & Record<string, unknown>;

export interface IVibeideSettingsService {
	readonly _serviceBrand: undefined;
	readonly state: VibeideSettingsState; // in order to play nicely with react, you should immutably change state
	readonly waitForInitState: Promise<void>;

	onDidChangeState: Event<void>;

	setSettingOfProvider: SetSettingOfProviderFn;
	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn;
	setOptionsOfModelSelection: SetOptionsOfModelSelection;
	setGlobalSetting: SetGlobalSettingFn;
	// setMCPServerStates: (newStates: MCPServerStates) => Promise<void>;

	// setting to undefined CLEARS it, unlike others:
	setOverridesOfModel(providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined): Promise<void>;

	/** Merge per-model overrides in one write (e.g. contextWindow from provider catalog). */
	mergeOverridesForProviderModels(providerName: ProviderName, updates: Record<string, Partial<ModelOverrides>>): Promise<void>;

	dangerousSetState(newState: VibeideSettingsState): Promise<void>;
	resetState(): Promise<void>;

	setAutodetectedModels(providerName: ProviderName, modelNames: string[], logging: AutodetectModelsLogging): Promise<void>;

	/** Drop per-model overrides that no longer exist in settingsOfProvider (e.g. after catalog sync). */
	pruneOverridesToProviderModels(providerName: ProviderName): Promise<void>;
	toggleModelHidden(providerName: ProviderName, modelName: string): void;
	addModel(providerName: ProviderName, modelName: string): void;
	deleteModel(providerName: ProviderName, modelName: string): boolean;

	/** Apply `.vibe/providers.json` disable-toggles for built-in providers/models. Derived (not
	 *  persisted) — recomputes the model picker + reselects if the active model became hidden. */
	applyProviderActiveOverrides(overrides: VibeProviderActiveOverrides | undefined): void;

	/** Transport configs of active dynamic providers (`.vibe/providers.json`), keyed by file id.
	 *  Merged transiently into `settingsOfProvider` on the send-site — never persisted. */
	getDynamicTransportConfigs(): Record<string, DynProviderTransportConfig>;

	addMCPUserStateOfNames(userStateOfName: MCPUserStateOfName): Promise<void>;
	removeMCPUserStateOfNames(serverNames: string[]): Promise<void>;
	setMCPServerState(serverName: string, state: MCPUserState): Promise<void>;

	/**
	 * Resolve "auto" model selection to a real model, or return null if no models are available
	 * This is a shared utility used across all features for consistent auto selection handling
	 */
	resolveAutoModelSelection(modelSelection: ModelSelection | null | undefined): ModelSelection | null;
}




const computeDidFillInProviderSettings = (providerName: ProviderName, settingsAtProvider: SettingsOfProvider[ProviderName]): boolean => {
	if (providerName === 'openRouter') {
		const s = settingsAtProvider as { apiKey?: string; publicCatalog?: string };
		if (s.publicCatalog === '1') {
			return true;
		}
		return !!s.apiKey?.trim();
	}
	return Object.keys(defaultProviderSettings[providerName]).every(key => !!settingsAtProvider[key as keyof typeof settingsAtProvider]);
};

const _modelsWithSwappedInNewModels = (options: { existingModels: VibeideStatefulModelInfo[]; models: string[]; type: 'autodetected' | 'default'; defaultHiddenForNew: boolean }) => {
	const { existingModels, models, type, defaultHiddenForNew } = options;

	const existingModelsMap: Record<string, VibeideStatefulModelInfo> = {};
	for (const existingModel of existingModels) {
		existingModelsMap[existingModel.modelName] = existingModel;
	}

	const newDefaultModels = models.map((modelName) => {
		const existing = existingModelsMap[modelName];
		return {
			modelName,
			type,
			isHidden: existing !== undefined ? !!existing.isHidden : defaultHiddenForNew,
		};
	});

	return [
		...newDefaultModels, // swap out all the models of this type for the new models of this type
		...existingModels.filter(m => {
			const keep = m.type !== type;
			return keep;
		})
	];
};


export const modelFilterOfFeatureName: {
	[featureName in FeatureName]: {
		filter: (
			o: ModelSelection,
			opts: { chatMode: ChatMode; overridesOfModel: OverridesOfModel }
		) => boolean;
		emptyMessage: null | { message: string; priority: 'always' | 'fallback' };
	} } = {
	'Autocomplete': {
		filter: (o, opts) => {
			// Skip "auto" option - it's not a real model
			if (o.providerName === 'auto' && o.modelName === 'auto') { return false; }
			const capabilities = getModelCapabilities(o.providerName, o.modelName, opts.overridesOfModel);

			// Check if model has FIM support
			if (capabilities.supportsFIM) { return true; }

			// Check if user manually enabled FIM via overrides
			if (opts.overridesOfModel?.[o.providerName]?.[o.modelName]?.supportsFIM === true) { return true; }

			// Allow providers that actually support FIM
			// Providers with confirmed FIM support:
			// - mistral: Native FIM endpoint (codestral models)
			// - ollama: Supports FIM (qwen2.5-coder models)
			// - openRouter: May support FIM depending on backend model
			// - openAICompatible: May support FIM if backend supports it (e.g., local servers)
			// - liteLLM: May support FIM depending on backend
			// Note: OpenAI's official API does NOT support suffix parameter (except gpt-3.5-turbo-instruct)
			// Note: vLLM and lmStudio do NOT support suffix parameter
			const providersWithFIMSupport: readonly ProviderName[] = ['mistral', 'ollama', 'openRouter', 'openAICompatible', 'liteLLM'];
			if (providersWithFIMSupport.includes(o.providerName)) {
				return true;
			}

			return false;
		}, emptyMessage: { message: 'Нет моделей с FIM. Облако: Mistral codestral-latest (нужен ключ Mistral). Локально: Ollama qwen2.5-coder. Официальный API OpenAI FIM не поддерживает; через OpenRouter — если бэкенд поддерживает FIM.', priority: 'always' }
	},
	'Chat': {
		filter: o => {
			// Always allow "Auto" option
			if (o.providerName === 'auto' && o.modelName === 'auto') { return true; }
			// For other models, check capabilities
			return true;
		}, emptyMessage: null,
	},
	'Ctrl+K': { filter: o => true, emptyMessage: null, },
	'Apply': { filter: o => true, emptyMessage: null, },
	'SCM': { filter: o => true, emptyMessage: null, },
};


const _stateWithMergedDefaultModels = (state: VibeideSettingsState): VibeideSettingsState => {
	let newSettingsOfProvider = state.settingsOfProvider;

	// recompute default models
	for (const providerName of providerNames) {
		const defaultModels = defaultSettingsOfProvider[providerName]?.models ?? [];
		const currentModels = newSettingsOfProvider[providerName]?.models ?? [];
		const defaultModelNames = defaultModels.map(m => m.modelName);
		const newModels = _modelsWithSwappedInNewModels({
			existingModels: currentModels,
			models: defaultModelNames,
			type: 'default',
			// Match modelInfoOfDefaultModelNames: bundle many defaults as hidden until user opts in
			defaultHiddenForNew: defaultModelNames.length >= 10,
		});
		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...newSettingsOfProvider[providerName],
				models: newModels,
			},
		};
	}
	return {
		...state,
		settingsOfProvider: newSettingsOfProvider,
	};
};

/**
 * Built-in providers/models the user disabled via `.vibe/providers.json` (`active: false`).
 * Set by the dynamic-providers service (browser) through `applyProviderActiveOverrides`; consumed in
 * `_validatedModelState` to drop them from the model picker (and trigger reselection if a hidden one
 * was selected). Module-level so the pure `_validatedModelState` reads it without threading.
 */
/** Transport config for a DYNAMIC provider, keyed by its file id. Merged transiently into
 *  `settingsOfProvider` at request time (NOT persisted) so the electron-main SDK factory can route
 *  an id that isn't a compile-time built-in. `apiKey` is resolved from `apiKeyRef` in the renderer;
 *  `apiKeyEnv` carries the env-var NAME (resolved in electron-main where `process.env` is reliable). */
export interface DynProviderTransportConfig {
	readonly baseURL: string;
	readonly headers?: Record<string, string>;
	readonly apiKey?: string;
	readonly apiKeyEnv?: string;
	/** Custom models-catalog URL from `models.fetch: "<url>"`. When set, the catalog fetch hits this
	 *  URL verbatim instead of the `<baseURL>/v1/models` default. */
	readonly modelsUrl?: string;
}

export interface VibeProviderActiveOverrides {
	readonly disabledProviders: ReadonlySet<string>;
	readonly disabledModels: ReadonlyMap<string, ReadonlySet<string>>;
	/** Selectable models contributed by DYNAMIC providers (definition / extends-builtin) from
	 *  `.vibe/providers.json`. Their `selection.providerName` is the file id (not a built-in union
	 *  member), so it's cast through `any` at construction — same trick as the "auto" option. These
	 *  are derived overlay options (NOT persisted); the request-time transport reads the matching
	 *  dynamic config from a transient merged `settingsOfProvider`. */
	readonly dynamicModelOptions?: readonly ModelOption[];
	/** Transport config per dynamic provider id — merged into `settingsOfProvider` at send time. */
	readonly transportConfigs?: Record<string, DynProviderTransportConfig>;
	/** First-class settings entries seeded for active dynamic providers so the Settings UI renders them
	 *  like built-ins (provider card + «Модели» tab). Merged into `settingsOfProvider` in
	 *  `_validatedModelState`. Derived (reapplied each load), never persisted in the settings blob. */
	readonly dynamicProviderSettings?: Record<string, DynamicProviderSeed>;
}

/** Shape of a seeded dynamic-provider entry (assignable to SettingsAtProvider via cast on merge). */
export type DynamicProviderSeed = {
	apiKey: string;
	endpoint: string;
	headersJSON?: string;
	models: VibeideStatefulModelInfo[];
	_didFillInProviderSettings: boolean;
	/** Key validation status shown in the provider card. `valid` = the models endpoint authenticated;
	 *  `invalid` = 401/403; `error` = network/server; `pending` = probe in flight; `unverified` =
	 *  static-only (`fetch:false`, no probe); `none` = no key resolved. */
	keyStatus?: 'valid' | 'invalid' | 'error' | 'pending' | 'unverified' | 'none';
	/** Where the resolved key came from — surfaced in the card so the user knows what's in effect. */
	keySource?: 'gui' | 'env' | 'ref' | 'none';
	/** Per-model caps from the file `static` list, carried so the SEND PATH (electron-main) can register
	 *  this provider into its own copy of the caps registry — settingsOfProvider crosses the process
	 *  boundary per request, the renderer-side registry doesn't. */
	modelCapOverrides?: { [modelId: string]: Partial<VibeideStaticModelInfo> };
};
let _providerActiveOverrides: VibeProviderActiveOverrides | undefined = undefined;

const _validatedModelState = (state: Omit<VibeideSettingsState, '_modelOptions'>): VibeideSettingsState => {

	let newSettingsOfProvider = state.settingsOfProvider;

	// recompute _didFillInProviderSettings
	for (const providerName of providerNames) {
		const settingsAtProvider = newSettingsOfProvider[providerName];

		const didFillInProviderSettings = computeDidFillInProviderSettings(providerName, settingsAtProvider);

		if (didFillInProviderSettings === settingsAtProvider._didFillInProviderSettings) { continue; }

		newSettingsOfProvider = {
			...newSettingsOfProvider,
			[providerName]: {
				...settingsAtProvider,
				_didFillInProviderSettings: didFillInProviderSettings,
			},
		};
	}

	// Seed dynamic providers (.vibe/providers.json) as first-class entries so the Settings UI (provider
	// cards + «Модели» tab) iterates them exactly like built-ins. The chat picker still sources dynamics
	// from `dynamicModelOptions` below, so the model-options loop deliberately stays built-in-only — no
	// double counting. These entries are derived (reapplied each load), never written to the blob.
	if (_providerActiveOverrides?.dynamicProviderSettings) {
		const merged: Record<string, unknown> = { ...newSettingsOfProvider };
		for (const [id, seed] of Object.entries(_providerActiveOverrides.dynamicProviderSettings)) {
			merged[id] = seed;
		}
		newSettingsOfProvider = merged as unknown as typeof newSettingsOfProvider;
	}

	// update model options
	const newModelOptions: ModelOption[] = [];
	// Add "Auto" option first (only for Chat feature)
	// Note: 'auto' is not a real ProviderName, but we use it as a special marker
	const autoOption: ModelOption = { name: 'Auto', selection: { providerName: 'auto', modelName: 'auto' } };
	newModelOptions.push(autoOption);

	// Dynamic providers (.vibe/providers.json) surface at the TOP — right after "Auto", ABOVE the
	// built-ins — because they're the user's explicitly-configured providers and should be prominent.
	// They're already sorted among themselves by `order` (then name) upstream in vibeDynamicProvidersService.
	if (_providerActiveOverrides?.dynamicModelOptions?.length) {
		newModelOptions.push(..._providerActiveOverrides.dynamicModelOptions);
	}

	for (const providerName of providerNames) {
		if (_providerActiveOverrides?.disabledProviders.has(providerName)) { continue; } // .vibe/providers.json: active:false
		const providerTitle = providerName; // displayInfoOfProviderName(providerName).title.toLowerCase() // looks better lowercase, best practice to not use raw providerName
		if (!newSettingsOfProvider[providerName]._didFillInProviderSettings) { continue; } // if disabled, don't display model options
		const disabledModelsForProvider = _providerActiveOverrides?.disabledModels.get(providerName);
		for (const { modelName, isHidden } of newSettingsOfProvider[providerName].models) {
			if (isHidden) { continue; }
			if (disabledModelsForProvider?.has(modelName)) { continue; } // .vibe/providers.json: model active:false
			newModelOptions.push({ name: `${modelName} (${providerTitle})`, selection: { providerName, modelName } });
		}
	}

	// now that model options are updated, make sure the selection is valid
	// if the user-selected model is no longer in the list, update the selection for each feature that needs it to something relevant (the 0th model available, or null)
	let newModelSelectionOfFeature = state.modelSelectionOfFeature;
	for (const featureName of featureNames) {

		const { filter } = modelFilterOfFeatureName[featureName];
		const filterOpts = { chatMode: state.globalSettings.chatMode, overridesOfModel: state.overridesOfModel };
		// For Chat feature, include "Auto" option; for others, filter it out
		const allOptionsForFeature = featureName === 'Chat'
			? newModelOptions
			: newModelOptions.filter((o) => !(o.selection.providerName === 'auto' && o.selection.modelName === 'auto'));
		const modelOptionsForThisFeature = allOptionsForFeature.filter((o) => filter(o.selection, filterOpts));

		const modelSelectionAtFeature = newModelSelectionOfFeature[featureName];
		const selnIdx = modelSelectionAtFeature === null ? -1 : modelOptionsForThisFeature.findIndex(m => modelSelectionsEqual(m.selection, modelSelectionAtFeature));

		if (selnIdx !== -1) { continue; } // still in the list — keep the selection

		// Don't clobber a DYNAMIC-provider selection (.vibe/providers.json) just because it isn't in the
		// options right now: the overlay + catalog load ASYNC at startup (and a catalog model stays
		// `pending` until its key is validated), so this validation runs before the model appears. Reset
		// only when the overlay HAS loaded AND the provider is gone (removed from the file) — otherwise
		// the persisted selection was reset on every launch. Built-in selections reset as before.
		const sel = modelSelectionAtFeature;
		if (sel && sel.providerName !== 'auto' && !(providerNames as readonly string[]).includes(sel.providerName)) {
			const providerStillActive = !_providerActiveOverrides || !!_providerActiveOverrides.dynamicProviderSettings?.[sel.providerName];
			if (providerStillActive) { continue; }
		}

		newModelSelectionOfFeature = {
			...newModelSelectionOfFeature,
			[featureName]: modelOptionsForThisFeature.length === 0 ? null : modelOptionsForThisFeature[0].selection
		};
	}


	const newState = {
		...state,
		settingsOfProvider: newSettingsOfProvider,
		modelSelectionOfFeature: newModelSelectionOfFeature,
		overridesOfModel: state.overridesOfModel,
		_modelOptions: newModelOptions,
	} satisfies VibeideSettingsState;

	return newState;
};





const defaultState = () => {
	const d: VibeideSettingsState = {
		settingsOfProvider: deepClone(defaultSettingsOfProvider),
		modelSelectionOfFeature: { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': null, 'Apply': null, 'SCM': null },
		globalSettings: deepClone(defaultGlobalSettings),
		optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'Apply': {}, 'SCM': {} },
		overridesOfModel: deepClone(defaultOverridesOfModel),
		_modelOptions: [], // computed later
		mcpUserStateOfName: {},
		dynamicProviderApiKeys: {},
		dynamicModelHidden: {},
	};
	return d;
};


export const IVibeideSettingsService = createDecorator<IVibeideSettingsService>('VibeideSettingsService');
class VoidSettingsService extends Disposable implements IVibeideSettingsService {
	_serviceBrand: undefined;

	private readonly _onDidChangeState = new Emitter<void>();
	readonly onDidChangeState: Event<void> = this._onDidChangeState.event; // this is primarily for use in react, so react can listen + update on state changes

	state: VibeideSettingsState;

	private readonly _resolver: () => void;
	waitForInitState: Promise<void>; // await this if you need a valid state initially

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		// could have used this, but it's clearer the way it is (+ slightly different eg StorageTarget.USER)
		// @ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
	) {
		super();

		// at the start, we haven't read the partial config yet, but we need to set state to something
		this.state = defaultState();
		let resolver: () => void = () => { };
		this.waitForInitState = new Promise((res, rej) => resolver = res);
		this._resolver = resolver;

		// Subscribe to VS Code configuration changes for localFirstAI
		// This ensures state stays in sync when user changes the setting in VS Code Settings UI
		this._register(
			this._configurationService.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('vibeide.global.localFirstAI')) {
					const configValue = this._configurationService.getValue<boolean>('vibeide.global.localFirstAI') ?? false;
					// Update state if it differs from current value
					if (this.state.globalSettings.localFirstAI !== configValue) {
						const newState: VibeideSettingsState = {
							...this.state,
							globalSettings: {
								...this.state.globalSettings,
								localFirstAI: configValue
							}
						};
						this.state = _validatedModelState(newState);
						// Don't write to storage - VS Code config is the source of truth
						this._onDidChangeState.fire();
					}
				}
			})
		);

		this.readAndInitializeState();
	}




	dangerousSetState = async (newState: VibeideSettingsState) => {
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._onUpdate_syncApplyToChat();
		this._onUpdate_syncSCMToChat();
	};

	applyProviderActiveOverrides = (overrides: VibeProviderActiveOverrides | undefined): void => {
		_providerActiveOverrides = overrides;
		// Recompute model options + selection against the new overrides. No _storeState — these are
		// derived from .vibe/providers.json (reapplied on every load), not persisted user settings.
		this.state = _validatedModelState(this.state);
		this._onDidChangeState.fire();
	};

	getDynamicTransportConfigs = (): Record<string, DynProviderTransportConfig> => {
		return _providerActiveOverrides?.transportConfigs ?? {};
	};
	async resetState() {
		await this.dangerousSetState(defaultState());
	}




	async readAndInitializeState() {
		let readS: VibeideSettingsState;
		try {
			readS = await this._readState();
			const rw = readS as unknown as LegacyMigrationState;
			// 1.0.3 addition, remove when enough users have had this code run
			if (rw.globalSettings.includeToolLintErrors === undefined) { rw.globalSettings.includeToolLintErrors = true; }

			// autoapprove is now an obj not a boolean (1.2.5)
			if (typeof rw.globalSettings.autoApprove === 'boolean') { rw.globalSettings.autoApprove = {}; }

			// 1.3.5 add source control feature
			if (rw.modelSelectionOfFeature && !rw.modelSelectionOfFeature['SCM']) {
				rw.modelSelectionOfFeature['SCM'] = deepClone(rw.modelSelectionOfFeature['Chat']);
				rw.optionsOfModelSelection['SCM'] = deepClone(rw.optionsOfModelSelection['Chat']);
			}
			// add disableSystemMessage feature
			if (rw.globalSettings.disableSystemMessage === undefined) { rw.globalSettings.disableSystemMessage = false; }

			// add autoAcceptLLMChanges feature
			if (rw.globalSettings.autoAcceptLLMChanges === undefined) { rw.globalSettings.autoAcceptLLMChanges = false; }

			// 1.2.4: provider id `openCode` (OpenCode Go) renamed to `openCodeGo`. Move any config
			// stored under the legacy key to the new one BEFORE the normalization loop below (which
			// iterates the renamed `providerNames`), so existing users keep their key/models instead
			// of silently getting a fresh empty provider.
			if (rw.settingsOfProvider && rw.settingsOfProvider.openCode && !rw.settingsOfProvider.openCodeGo) {
				rw.settingsOfProvider.openCodeGo = rw.settingsOfProvider.openCode;
				delete rw.settingsOfProvider.openCode;
			}
			readS = rw as unknown as VibeideSettingsState;
		}
		catch (e) {
			readS = defaultState();
		}

		// the stored data structure might be outdated, so we need to update it here
		try {
			const migrBase = {
				...defaultState(),
				...readS,
				// no idea why this was here, seems like a bug
				// ...defaultSettingsOfProvider,
				// ...readS.settingsOfProvider,
			};
			const migr = migrBase as unknown as LegacyMigrationState;
			const mergedGlobalSettings = {
				...defaultState().globalSettings,
				...migr.globalSettings,
			};
			migr.globalSettings = mergedGlobalSettings as unknown as LegacyGlobalSettings;

			for (const providerName of providerNames) {
				const mergedProvider = {
					...defaultSettingsOfProvider[providerName],
					...migr.settingsOfProvider[providerName],
				};
				migr.settingsOfProvider[providerName] = mergedProvider as unknown as LegacyProviderSettings;

				// conversion from 1.0.3 to 1.2.5 (can remove this when enough people update)
				for (const m of migr.settingsOfProvider[providerName].models) {
					if (!m.type) {
						const old = (m as { isAutodetected?: boolean; isDefault?: boolean });
						if (old.isAutodetected) { m.type = 'autodetected'; }
						else if (old.isDefault) { m.type = 'default'; }
						else { m.type = 'custom'; }
					}
					// Legacy rows without isHidden: treated as visible (falsy), which turned whole remote catalogs "on"
					if (typeof m.isHidden !== 'boolean') {
						m.isHidden = m.type === 'autodetected';
					}
				}

				// Heal huge remote-catalog pulls where every autodetected row was stored visible (legacy isHidden / merge bug)
				const modelsAtP: VibeideStatefulModelInfo[] = migr.settingsOfProvider[providerName].models as VibeideStatefulModelInfo[];
				const autodetected = modelsAtP.filter((m): m is VibeideStatefulModelInfo & { type: 'autodetected' } => m.type === 'autodetected');
				if (
					(providerName === 'openRouter' || providerName === 'openAICompatible' || providerName === 'liteLLM')
					&& autodetected.length >= 100
					&& autodetected.every((m) => m.isHidden === false)
				) {
					const healedProvider = {
						...migr.settingsOfProvider[providerName],
						models: modelsAtP.map((m) =>
							m.type === 'autodetected' ? { ...m, isHidden: true } : m
						),
					};
					migr.settingsOfProvider[providerName] = healedProvider as unknown as LegacyProviderSettings;
				}

				// remove when enough people have had it run (default is now {})
				if (providerName === 'openAICompatible' && !migr.settingsOfProvider[providerName].headersJSON) {
					migr.settingsOfProvider[providerName].headersJSON = '{}';
				}
			}
			readS = migr as unknown as VibeideSettingsState;
		}

		catch (e) {
			readS = defaultState();
		}

		this.state = readS;
		this.state = _stateWithMergedDefaultModels(this.state);
		this.state = _validatedModelState(this.state);

		// Override localFirstAI from VS Code configuration (source of truth)
		// This ensures VS Code Settings UI controls the behavior
		const configLocalFirstAI = this._configurationService.getValue<boolean>('vibeide.global.localFirstAI');
		if (configLocalFirstAI !== undefined) {
			this.state.globalSettings.localFirstAI = configLocalFirstAI;
		}

		this._resolver();
		this._onDidChangeState.fire();

	}


	private async _readState(): Promise<VibeideSettingsState> {
		const encryptedState = this._storageService.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);

		if (!encryptedState) { return defaultState(); }

		const stateStr = await this._encryptionService.decrypt(encryptedState);
		const state = JSON.parse(stateStr);
		return state;
	}


	private async _storeState() {
		const state = this.state;
		// Dynamic providers (.vibe/providers.json) are SEEDED into settingsOfProvider at runtime (derived
		// from the file overlay, reapplied each load). They must NOT be persisted into the settings blob —
		// otherwise a provider later removed from the file would linger as a ghost card. Strip every
		// non-built-in entry before serializing; the overlay re-seeds the live ones on next launch.
		const builtinSet = new Set<string>(providerNames as readonly string[]);
		const sop = state.settingsOfProvider as Record<string, unknown>;
		const cleanedSettingsOfProvider: Record<string, unknown> = {};
		for (const k of Object.keys(sop)) {
			if (builtinSet.has(k)) { cleanedSettingsOfProvider[k] = sop[k]; }
		}
		const toStore = { ...state, settingsOfProvider: cleanedSettingsOfProvider };
		const encryptedState = await this._encryptionService.encrypt(JSON.stringify(toStore));
		this._storageService.store(VOID_SETTINGS_STORAGE_KEY, encryptedState, StorageScope.APPLICATION, StorageTarget.USER);
	}

	setSettingOfProvider: SetSettingOfProviderFn = async (providerName, settingName, newVal) => {

		// Dynamic providers (.vibe/providers.json) aren't in the typed settingsOfProvider blob; their only
		// user-editable field is the API key, which persists in a side map. The dynamic-providers service
		// observes this change and folds the key back into resolution + the seeded entry on its reload.
		if (!(providerNames as readonly string[]).includes(providerName as unknown as string)) {
			if (settingName !== 'apiKey') { return; }
			const newState: VibeideSettingsState = {
				...this.state,
				dynamicProviderApiKeys: {
					...(this.state.dynamicProviderApiKeys ?? {}),
					[providerName as unknown as string]: (newVal as string) ?? '',
				},
			};
			this.state = _validatedModelState(newState);
			await this._storeState();
			this._onDidChangeState.fire();
			return;
		}

		const newSettingsOfProvider: SettingsOfProvider = {
			...this.state.settingsOfProvider,
			[providerName]: {
				...this.state.settingsOfProvider[providerName],
				[settingName]: newVal,
			}
		};

		const newState: VibeideSettingsState = {
			...this.state,
			settingsOfProvider: newSettingsOfProvider,
		};

		this.state = _validatedModelState(newState);

		await this._storeState();
		this._onDidChangeState.fire();

	};


	private _onUpdate_syncApplyToChat() {
		// if sync is turned on, sync (call this whenever Chat model or !!sync changes)
		this.setModelSelectionOfFeature('Apply', deepClone(this.state.modelSelectionOfFeature['Chat']));
	}

	private _onUpdate_syncSCMToChat() {
		this.setModelSelectionOfFeature('SCM', deepClone(this.state.modelSelectionOfFeature['Chat']));
	}

	setGlobalSetting: SetGlobalSettingFn = async (settingName, newVal) => {
		// Special handling for localFirstAI: write to VS Code config (source of truth)
		// This ensures consistency if internal UI ever exposes this setting
		if (settingName === 'localFirstAI') {
			await this._configurationService.updateValue('vibeide.global.localFirstAI', newVal);
			// State will be updated via config change listener, so return early
			return;
		}

		const newState: VibeideSettingsState = {
			...this.state,
			globalSettings: {
				...this.state.globalSettings,
				[settingName]: newVal
			}
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();

		// hooks
		if (this.state.globalSettings.syncApplyToChat) { this._onUpdate_syncApplyToChat(); }
		if (this.state.globalSettings.syncSCMToChat) { this._onUpdate_syncSCMToChat(); }

	};


	setModelSelectionOfFeature: SetModelSelectionOfFeatureFn = async (featureName, newVal) => {
		const newState: VibeideSettingsState = {
			...this.state,
			modelSelectionOfFeature: {
				...this.state.modelSelectionOfFeature,
				[featureName]: newVal
			}
		};

		this.state = _validatedModelState(newState);

		await this._storeState();
		this._onDidChangeState.fire();

		// hooks
		if (featureName === 'Chat') {
			// When Chat model changes, update synced features
			this._onUpdate_syncApplyToChat();
			this._onUpdate_syncSCMToChat();
			// Propagate to Ctrl+K and Autocomplete if they have no model yet (first-time setup)
			if (!this.state.modelSelectionOfFeature['Ctrl+K']) {
				await this.setModelSelectionOfFeature('Ctrl+K', deepClone(this.state.modelSelectionOfFeature['Chat']));
			}
			if (!this.state.modelSelectionOfFeature['Autocomplete']) {
				await this.setModelSelectionOfFeature('Autocomplete', deepClone(this.state.modelSelectionOfFeature['Chat']));
			}
		}
	};


	setOptionsOfModelSelection = async (featureName: FeatureName, providerName: ProviderName, modelName: string, newVal: Partial<ModelSelectionOptions>) => {
		const newState: VibeideSettingsState = {
			...this.state,
			optionsOfModelSelection: {
				...this.state.optionsOfModelSelection,
				[featureName]: {
					...this.state.optionsOfModelSelection[featureName],
					[providerName]: {
						...this.state.optionsOfModelSelection[featureName][providerName],
						[modelName]: {
							...this.state.optionsOfModelSelection[featureName][providerName]?.[modelName],
							...newVal
						}
					}
				}
			}
		};
		this.state = _validatedModelState(newState);

		await this._storeState();
		this._onDidChangeState.fire();
	};

	setOverridesOfModel = async (providerName: ProviderName, modelName: string, overrides: Partial<ModelOverrides> | undefined) => {
		const newState: VibeideSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: {
					...this.state.overridesOfModel[providerName],
					[modelName]: overrides === undefined ? undefined : {
						...this.state.overridesOfModel[providerName][modelName],
						...overrides
					},
				}
			}
		};

		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();

		this._metricsService.capture('Update Model Overrides', { providerName, modelName, overrides });
	};

	mergeOverridesForProviderModels = async (providerName: ProviderName, updates: Record<string, Partial<ModelOverrides>>) => {
		const prev = this.state.overridesOfModel[providerName] ?? {};
		const merged = { ...prev };
		for (const [modelName, partial] of Object.entries(updates)) {
			if (!partial || Object.keys(partial).length === 0) {
				continue;
			}
			merged[modelName] = { ...merged[modelName], ...partial };
		}
		const newState: VibeideSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: merged,
			},
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._metricsService.capture('Merge Model Overrides (catalog)', { providerName, modelNames: Object.keys(updates) });
	};




	setAutodetectedModels = async (providerName: ProviderName, autodetectedModelNames: string[], logging: AutodetectModelsLogging) => {

		const { models } = this.state.settingsOfProvider[providerName];
		const oldModelNames = models.map(m => m.modelName);

		// Remote catalogs: default new ids to hidden (user opts in). Local autodetect keeps old opt-in semantics.
		const defaultHiddenForNew = logging.source === 'remoteCatalog'
			? logging.defaultHiddenForNew !== false
			: logging.defaultHiddenForNew === true;

		const newModels = _modelsWithSwappedInNewModels({
			existingModels: models,
			models: autodetectedModelNames,
			type: 'autodetected',
			defaultHiddenForNew,
		});
		await this.setSettingOfProvider(providerName, 'models', newModels);

		// if the models changed, log it
		const new_names = newModels.map(m => m.modelName);
		if (!(oldModelNames.length === new_names.length
			&& oldModelNames.every((_, i) => oldModelNames[i] === new_names[i]))
		) {
			this._metricsService.capture('Autodetect Models', { providerName, newModels: newModels, ...logging });
		}
	};

	pruneOverridesToProviderModels = async (providerName: ProviderName) => {
		const names = new Set(this.state.settingsOfProvider[providerName].models.map(m => m.modelName));
		const prev = this.state.overridesOfModel[providerName] ?? {};
		const removed = Object.keys(prev).filter(k => !names.has(k));
		if (removed.length === 0) {
			return;
		}
		const next: Record<string, Partial<ModelOverrides>> = {};
		for (const [k, v] of Object.entries(prev)) {
			if (names.has(k) && v !== undefined) {
				next[k] = v;
			}
		}
		const newState: VibeideSettingsState = {
			...this.state,
			overridesOfModel: {
				...this.state.overridesOfModel,
				[providerName]: next,
			},
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._metricsService.capture('Prune Model Overrides (catalog)', { providerName, removed });
	};
	toggleModelHidden(providerName: ProviderName, modelName: string) {

		// Dynamic providers (.vibe/providers.json): the model list is derived from the file/catalog
		// overlay, so a hide toggle persists as an explicit override; the dynamic-providers service
		// re-applies it (and re-gates the chat picker) on the resulting state change.
		if (!(providerNames as readonly string[]).includes(providerName as unknown as string)) {
			const id = providerName as unknown as string;
			const seed = (this.state.settingsOfProvider as Record<string, { models?: VibeideStatefulModelInfo[] } | undefined>)[id];
			const cur = seed?.models?.find(m => m.modelName === modelName);
			if (!cur) { return; }
			const newHidden = !cur.isHidden;
			const newState: VibeideSettingsState = {
				...this.state,
				dynamicModelHidden: {
					...(this.state.dynamicModelHidden ?? {}),
					[id]: { ...(this.state.dynamicModelHidden?.[id] ?? {}), [modelName]: newHidden },
				},
			};
			this.state = _validatedModelState(newState);
			void this._storeState();
			this._onDidChangeState.fire();
			this._metricsService.capture('Toggle Dynamic Model Hidden', { providerName, modelName, newHidden });
			return;
		}

		const { models } = this.state.settingsOfProvider[providerName];
		const modelIdx = models.findIndex(m => m.modelName === modelName);
		if (modelIdx === -1) { return; }
		const newIsHidden = !models[modelIdx].isHidden;
		const newModels: VibeideStatefulModelInfo[] = [
			...models.slice(0, modelIdx),
			{ ...models[modelIdx], isHidden: newIsHidden },
			...models.slice(modelIdx + 1, Infinity)
		];
		this.setSettingOfProvider(providerName, 'models', newModels);

		this._metricsService.capture('Toggle Model Hidden', { providerName, modelName, newIsHidden });

	}
	addModel(providerName: ProviderName, modelName: string) {
		const { models } = this.state.settingsOfProvider[providerName];
		const existingIdx = models.findIndex(m => m.modelName === modelName);
		if (existingIdx !== -1) { return; } // if exists, do nothing
		const newModels = [
			...models,
			{ modelName, type: 'custom', isHidden: false } as const
		];
		this.setSettingOfProvider(providerName, 'models', newModels);

		this._metricsService.capture('Add Model', { providerName, modelName });

	}
	deleteModel(providerName: ProviderName, modelName: string): boolean {
		const { models } = this.state.settingsOfProvider[providerName];
		const delIdx = models.findIndex(m => m.modelName === modelName);
		if (delIdx === -1) { return false; }
		const newModels = [
			...models.slice(0, delIdx), // delete the idx
			...models.slice(delIdx + 1, Infinity)
		];
		this.setSettingOfProvider(providerName, 'models', newModels);

		this._metricsService.capture('Delete Model', { providerName, modelName });

		return true;
	}

	// MCP Server State
	private _setMCPUserStateOfName = async (newStates: MCPUserStateOfName) => {
		const newState: VibeideSettingsState = {
			...this.state,
			mcpUserStateOfName: {
				...this.state.mcpUserStateOfName,
				...newStates
			}
		};
		this.state = _validatedModelState(newState);
		await this._storeState();
		this._onDidChangeState.fire();
		this._metricsService.capture('Set MCP Server States', { newStates });
	};

	addMCPUserStateOfNames = async (newMCPStates: MCPUserStateOfName) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state;
		const newMCPServerStates = {
			...mcpServerStates,
			...newMCPStates,
		};
		await this._setMCPUserStateOfName(newMCPServerStates);
		this._metricsService.capture('Add MCP Servers', { servers: Object.keys(newMCPStates).join(', ') });
	};

	removeMCPUserStateOfNames = async (serverNames: string[]) => {
		const { mcpUserStateOfName: mcpServerStates } = this.state;
		const newMCPServerStates = {
			...mcpServerStates,
		};
		serverNames.forEach(serverName => {
			if (Object.hasOwn(newMCPServerStates, serverName)) {
				delete newMCPServerStates[serverName];
			}
		});
		await this._setMCPUserStateOfName(newMCPServerStates);
		this._metricsService.capture('Remove MCP Servers', { servers: serverNames.join(', ') });
	};

	setMCPServerState = async (serverName: string, state: MCPUserState) => {
		const { mcpUserStateOfName } = this.state;
		const newMCPServerStates = {
			...mcpUserStateOfName,
			[serverName]: state,
		};
		await this._setMCPUserStateOfName(newMCPServerStates);
		this._metricsService.capture('Update MCP Server State', { serverName, state });
	};

	/**
	 * Resolve "auto" model selection to a real model, or return null if no models are available
	 * This is a shared utility used across all features for consistent auto selection handling
	 */
	resolveAutoModelSelection(modelSelection: ModelSelection | null | undefined): ModelSelection | null {
		// If selection is null/undefined or not "auto", return as-is
		if (!modelSelection || !(modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto')) {
			return modelSelection || null;
		}

		// Try to find the first available configured model (prefer online models first, then local)
		for (const providerName of autoModelFallbackProviderOrder) {
			const providerSettings = this.state.settingsOfProvider[providerName];
			if (providerSettings && providerSettings._didFillInProviderSettings) {
				const models = providerSettings.models || [];
				const firstModel = models.find(m => !m.isHidden);
				if (firstModel) {
					return {
						providerName,
						modelName: firstModel.modelName,
					};
				}
			}
		}

		// No models available
		return null;
	}

}


registerSingleton(IVibeideSettingsService, VoidSettingsService, InstantiationType.Eager);
