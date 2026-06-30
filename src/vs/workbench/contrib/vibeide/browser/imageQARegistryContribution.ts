/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { initializeModelRegistry, imageQARegistry } from '../common/imageQA/index.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ILanguageModelsService } from '../../../contrib/chat/common/languageModels.js';

/**
 * Workbench contribution to initialize Image QA Model Registry
 * Registers models at startup and listens for new model availability
 */
class ImageQARegistryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.imageQARegistry';
	constructor(
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
	) {
		super();
		this.initialize();
	}

	private async initialize(): Promise<void> {
		// Initialize registry with default local models
		initializeModelRegistry();
		vibeLog.debug('imageQARegistry', '[ImageQA] Initialized model registry with default models');

		// Wait for settings to be ready
		await this.vibeideSettingsService.waitForInitState;

		// Register dynamically detected models
		this.registerDetectedModels();

		// Listen for model changes to update registry
		this._register(this.languageModelsService.onDidChangeLanguageModels(() => {
			this.registerDetectedModels();
		}));
	}

	/**
	 * Register detected local models (Ollama/vLLM) dynamically
	 */
	private async registerDetectedModels(): Promise<void> {
		try {
			const modelIds = this.languageModelsService.getLanguageModelIds();

			for (const modelId of modelIds) {
				const model = this.languageModelsService.lookupLanguageModel(modelId);
				if (!model) { continue; }

				// Try to extract provider and model name from identifier
				// Format could be "provider/model" or just a model name
				let providerName: string | undefined;
				let modelName: string;

				// Check if identifier contains known provider prefixes
				if (modelId.startsWith('ollama/')) {
					providerName = 'ollama';
					modelName = modelId.substring(7); // Remove "ollama/" prefix
				} else if (modelId.startsWith('vllm/') || modelId.startsWith('vLLM/')) {
					providerName = 'vllm';
					modelName = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
				} else if (modelId.startsWith('lmStudio/') || modelId.startsWith('lm-studio/')) {
					providerName = 'lmStudio';
					modelName = modelId.includes('/') ? modelId.split('/').slice(1).join('/') : modelId;
				} else {
					// Skip if not a recognized local provider
					continue;
				}

				// Ensure we have a valid provider name
				if (!providerName) {
					continue;
				}

				// Check if already registered
				if (imageQARegistry.get(providerName, modelName)) {
					continue;
				}

				// Determine model role based on capabilities
				let role: 'code' | 'vlm' | 'ocr' = 'code';
				let maxPx = 0;
				const strongAt: string[] = [];
				const weakAt: string[] = [];

				// Check if model supports vision
				if (model.capabilities?.vision) {
					role = 'vlm';
					maxPx = 1_000_000; // Default max pixels for vision models
					strongAt.push('layout', 'region_proposals', 'charts', 'UI/app', 'diagrams');
					weakAt.push('tiny_text', 'precise_OCR');
				} else {
					// Code model
					strongAt.push('reasoning', 'code', 'terminal/log', 'error_analysis');
					weakAt.push('visual_layout', 'non_text');
				}

				// Register the model
				imageQARegistry.register({
					role,
					modelName,
					providerName,
					max_px: maxPx,
					strong_at: strongAt,
					weak_at: weakAt,
					cost: 0, // Local models are free
					latency: role === 'vlm' ? 'high' : 'medium',
					contextWindow: model.maxInputTokens, // Use maxInputTokens as context window estimate
				});

				vibeLog.debug('imageQARegistry', `[ImageQA] Registered ${providerName}:${modelName} as ${role}`);
			}
		} catch (error) {
			vibeLog.error('imageQARegistry', '[ImageQA] Error registering detected models:', error);
		}
	}
}

// Register contribution
registerWorkbenchContribution2(ImageQARegistryContribution.ID, ImageQARegistryContribution, WorkbenchPhase.AfterRestored);

