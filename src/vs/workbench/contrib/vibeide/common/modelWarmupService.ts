/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILLMMessageService } from './sendLLMMessageService.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { ModelSelection, ProviderName, FeatureName } from './vibeideSettingsTypes.js';
import { isLocalProvider } from './isLocalProvider.js';

export interface IModelWarmupService {
	readonly _serviceBrand: undefined;
	/**
	 * Warm up a local model if it hasn't been warmed up recently.
	 * This fires a tiny background request to keep the model ready.
	 * @param providerName Provider name
	 * @param modelName Model name
	 * @param featureName Feature using the model (for context)
	 */
	warmupModelIfNeeded(providerName: ProviderName, modelName: string, featureName: FeatureName): void;
}

export const IModelWarmupService = createDecorator<IModelWarmupService>('ModelWarmupService');

/**
 * Lightweight warm-up service for local models.
 * Tracks when models were last warmed up and fires tiny background requests
 * to keep local models ready, reducing first-request latency.
 */
export class ModelWarmupService extends Disposable implements IModelWarmupService {
	static readonly ID = 'vibeide.modelWarmupService';

	_serviceBrand: undefined;

	/**
	 * Track last warm-up time per (providerName, modelName).
	 * Key format: `${providerName}:${modelName}`
	 */
	private readonly _lastWarmupTime = new Map<string, number>();

	/**
	 * Cooldown period in milliseconds (60-120 seconds as specified).
	 * Models won't be warmed up more than once per cooldown period.
	 */
	private readonly WARMUP_COOLDOWN_MS = 90_000; // 90 seconds

	constructor(
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
	}

	/**
	 * Warm up a local model if needed (not warmed up recently).
	 * This is a fire-and-forget operation that never blocks.
	 */
	warmupModelIfNeeded(providerName: ProviderName, modelName: string, featureName: FeatureName): void {
		// Only warm up local providers
		const settingsOfProvider = this._settingsService.state.settingsOfProvider;
		if (!isLocalProvider(providerName, settingsOfProvider)) {
			return; // Skip cloud providers
		}

		// Skip "auto" model (providerName is already validated by isLocalProvider check above)
		if (modelName === 'auto') {
			return;
		}

		const cacheKey = `${providerName}:${modelName}`;
		const lastWarmup = this._lastWarmupTime.get(cacheKey);
		const now = Date.now();

		// Check cooldown
		if (lastWarmup && (now - lastWarmup) < this.WARMUP_COOLDOWN_MS) {
			return; // Still in cooldown period
		}

		// Update warm-up time immediately to prevent duplicate warm-ups
		this._lastWarmupTime.set(cacheKey, now);

		// Fire tiny background request (1 token, minimal prompt)
		// This is fire-and-forget - we don't wait for it or handle errors
		this._warmupModelBackground(providerName, modelName, featureName).catch(() => {
			// Silently ignore errors - warm-up failures shouldn't affect user experience
			// Reset warm-up time on error so we can retry next time
			this._lastWarmupTime.delete(cacheKey);
		});
	}

	/**
	 * Fire a tiny background request to warm up the model.
	 * Uses minimal prompt (just ".") and 1 token to minimize overhead.
	 */
	private async _warmupModelBackground(providerName: ProviderName, modelName: string, featureName: FeatureName): Promise<void> {
		const modelSelection: ModelSelection = { providerName, modelName };
		const overridesOfModel = this._settingsService.state.overridesOfModel;

		// Use FIM for autocomplete, chat for others (minimal prompt)
		const isAutocomplete = featureName === 'Autocomplete';

		if (isAutocomplete) {
			// For FIM, use minimal prefix/suffix
			this._llmMessageService.sendLLMMessage({
				messagesType: 'FIMMessage',
				messages: {
					prefix: '.',
					suffix: '',
					stopTokens: [],
				},
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel,
				logging: { loggingName: 'Warmup' },
				onText: () => { }, // Ignore streaming
				onFinalMessage: () => { }, // Ignore result
				onError: () => { }, // Ignore errors
				onAbort: () => { },
			});
		} else {
			// For chat, use minimal message
			this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: '.' }],
				separateSystemMessage: undefined,
				chatMode: null,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel,
				logging: { loggingName: 'Warmup' },
				onText: () => { }, // Ignore streaming
				onFinalMessage: () => { }, // Ignore result
				onError: () => { }, // Ignore errors
				onAbort: () => { },
			});
		}
	}
}

registerSingleton(IModelWarmupService, ModelWarmupService, InstantiationType.Delayed);

