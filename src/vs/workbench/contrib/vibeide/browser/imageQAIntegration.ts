/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Integration service for Image QA Pipeline
 * Hooks into chat flow to process images locally before sending to LLM
 */

import { vibeLog } from '../common/vibeLog.js';
import { ChatImageAttachment } from '../common/chatThreadServiceTypes.js';
import { imageQAPipeline, type ImageQAOptions, type QAResponse } from '../common/imageQA/index.js';
import { ModelSelection, OverridesOfModel, ProviderName, SettingsOfProvider, VibeideStatefulModelInfo } from '../common/vibeideSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';

export interface ImageQAPreprocessedMessage {
	shouldUsePipeline: boolean;
	processedText?: string; // Text to send to LLM (may include OCR results)
	qaResponse?: QAResponse; // Direct answer if pipeline fully handled it
	images?: ChatImageAttachment[]; // Original images if still needed
}

// Providers whose chat models accept images natively (no local OCR needed)
const VISION_PROVIDERS = new Set<ProviderName>(['anthropic', 'openAI', 'gemini', 'pollinations']);
// Aggregator providers — vision is per-model; rely on catalog-driven `supportsVision` overrides
// or model-name heuristics rather than blanket-trusting the provider.
const AGGREGATOR_PROVIDERS = new Set(['openRouter', 'openCodeGo', 'openCodeZen', 'openAICompatible', 'liteLLM']);
const OLLAMA_VISION_KEYWORDS = ['llava', 'bakllava', 'llama-vision', 'qwen-vl'];
const AGGREGATOR_VISION_SUBSTRINGS = ['vision', '-vl', 'vl-', 'llava', 'pixtral', 'claude-3', 'claude-4', 'claude-sonnet', 'claude-opus', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'gemini'];

/**
 * Returns true if any vision-capable provider has a configured API key with at least one
 * non-hidden model. Used to treat `auto` provider as vision-capable when the router can
 * realistically resolve to Anthropic/OpenAI/Gemini.
 */
function hasAnyVisionProviderConfigured(settingsOfProvider?: SettingsOfProvider): boolean {
	if (!settingsOfProvider) { return false; }
	for (const name of VISION_PROVIDERS) {
		const s = settingsOfProvider[name];
		if (!s) { continue; }
		if (typeof s.apiKey === 'string' && s.apiKey.length > 10) {
			const hasEnabledModel = Array.isArray(s.models) && s.models.some((m: VibeideStatefulModelInfo) => !m.isHidden);
			if (hasEnabledModel) { return true; }
		}
	}
	return false;
}

/**
 * Lightweight vision-capability heuristic for OCR pipeline gating.
 * Skips the local OCR/QA preprocessing when the chosen LLM can read images itself.
 * Order: catalog override → native vision provider → aggregator heuristic → Ollama keyword.
 */
function isModelVisionCapable(modelSelection: ModelSelection | null, settingsOfProvider?: SettingsOfProvider, overridesOfModel?: OverridesOfModel): boolean {
	if (!modelSelection) { return false; }
	const { providerName, modelName } = modelSelection;
	if (providerName === 'auto') {
		// Router decides — if user has any vision-capable provider configured, trust it.
		return hasAnyVisionProviderConfigured(settingsOfProvider);
	}
	// Unified capability resolution (hardcoded → name recognition → catalog hint → override): covers
	// built-ins AND dynamic providers through the same registry. Definitive boolean wins; undefined
	// falls through to the legacy provider-set heuristics.
	const caps = getModelCapabilities(providerName, modelName, overridesOfModel);
	if (typeof caps.supportsVision === 'boolean') { return caps.supportsVision; }
	if (VISION_PROVIDERS.has(providerName)) { return true; }
	if (AGGREGATOR_PROVIDERS.has(providerName)) {
		const lower = (modelName || '').toLowerCase();
		return AGGREGATOR_VISION_SUBSTRINGS.some(s => lower.includes(s));
	}
	if (providerName === 'ollama') {
		const lower = (modelName || '').toLowerCase();
		return OLLAMA_VISION_KEYWORDS.some(k => lower.includes(k));
	}
	return false;
}

/**
 * Check if we should use the Image QA pipeline for this message.
 * Order: kill-switch → vision-capable model → has images.
 */
export function shouldUseImageQAPipeline(
	images: ChatImageAttachment[] | undefined,
	modelSelection?: ModelSelection | null,
	pipelineEnabled?: boolean,
	settingsOfProvider?: SettingsOfProvider,
	overridesOfModel?: OverridesOfModel
): boolean {
	if (!images || images.length === 0) { return false; }
	// Master kill-switch: pipeline is opt-in. Default off — native vision is the primary path.
	if (!pipelineEnabled) { return false; }
	// Vision-capable models read images directly — local OCR/QA is wasted work and surfaces tesseract errors when the worker fails to load.
	if (isModelVisionCapable(modelSelection ?? null, settingsOfProvider, overridesOfModel)) { return false; }
	return true;
}

// Cached probe: is tesseract.js actually loadable in this bundle?
// VS Code workbench is an ESM bundle; if the package isn't wired into the loader graph,
// dynamic import('tesseract.js') throws "Failed to resolve module specifier" — running the
// pipeline anyway just floods the console. We probe once and short-circuit thereafter.
let _ocrAvailability: Promise<boolean> | null = null;
function isOCRAvailable(): Promise<boolean> {
	if (_ocrAvailability) { return _ocrAvailability; }
	// Specifier kept in a variable so the probe exercises the same runtime dynamic-import path
	// as the real OCR loader without a statically-analyzable literal.
	const tesseractModule = 'tesseract.js';
	_ocrAvailability = import(tesseractModule).then(() => true).catch(() => false);
	return _ocrAvailability;
}

/**
 * Preprocess images through the QA pipeline
 * Returns processed text that can be sent to the code model
 */
export async function preprocessImagesForQA(
	images: ChatImageAttachment[],
	userQuestion: string,
	modelSelection: ModelSelection | null,
	devMode: boolean = false,
	settings?: {
		pipelineEnabled?: boolean;
		allowRemoteModels?: boolean;
		enableHybridMode?: boolean;
		settingsOfProvider?: SettingsOfProvider;
		overridesOfModel?: OverridesOfModel;
	}
): Promise<ImageQAPreprocessedMessage> {
	const pipelineEnabled = settings?.pipelineEnabled ?? false;
	const willUseOCR = shouldUseImageQAPipeline(images, modelSelection, pipelineEnabled, settings?.settingsOfProvider, settings?.overridesOfModel);
	if (devMode || pipelineEnabled) {
		// Diagnostic: surface the gate decision so users can see why OCR did or didn't run.
		vibeLog.debug('imageQAIntegration', '[ImageQA gate]', {
			provider: modelSelection?.providerName,
			model: modelSelection?.modelName,
			imageCount: images?.length ?? 0,
			pipelineEnabled,
			willUseOCR,
		});
	}
	if (!willUseOCR) {
		return { shouldUsePipeline: false, images };
	}
	// Skip the pipeline if OCR isn't loadable — running it would just throw on every send.
	if (!(await isOCRAvailable())) {
		return { shouldUsePipeline: false, images };
	}

	// For now, process the first image
	// In production, could process multiple or ask user to select
	const image = images[0];

	try {
		const allowRemoteModels = settings?.allowRemoteModels ?? false;
		const preferOnline = true; // Image and code tasks favor online models

		const options: ImageQAOptions = {
			imageData: image.data,
			mimeType: image.mimeType,
			width: image.width,
			height: image.height,
			userQuestion,
			codeModel: modelSelection ? {
				provider: modelSelection.providerName,
				model: modelSelection.modelName,
			} : undefined,
			devMode,
			allowRemoteModels,
			preferOnline,
		};

		const qaResponse = await imageQAPipeline.process(options);

		// Handle responses that need LLM processing
		if (qaResponse._needsLLM || qaResponse._needsVLM) {
			return {
				shouldUsePipeline: true,
				processedText: qaResponse._prompt || userQuestion,
				qaResponse,
				images: images, // Keep images for VLM/LLM processing
			};
		}

		// If confidence is high enough, use the pipeline answer directly
		if (qaResponse.confidence > 0.7 && !qaResponse.needsUserInput && qaResponse.answer) {
			return {
				shouldUsePipeline: true,
				qaResponse,
				processedText: qaResponse.answer,
			};
		}

		// Otherwise, include OCR results in the message for the LLM to reason about
		return {
			shouldUsePipeline: true,
			processedText: qaResponse.answer ? `[Image QA Pipeline] ${qaResponse.answer}\n\nIf you need more detail, please provide additional context.` : userQuestion,
			qaResponse,
			images: images, // Keep images for VLM if needed
		};

	} catch (error) {
		vibeLog.error('imageQAIntegration', '[ImageQA] Pipeline error:', error);

		// Fallback: send images normally
		return {
			shouldUsePipeline: false,
			images,
		};
	}
}

