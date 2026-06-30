/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import { SettingsOfProvider, ModelSelection, ProviderName, OverridesOfModel } from '../../../../common/vibeideSettingsTypes.js';
import { isVisionByNameHeuristic } from '../../../../common/modelVisionHeuristics.js';
import { getModelCapabilities } from '../../../../common/modelCapabilities.js';

/**
 * Vision-capable providers that require API keys.
 * Note: aggregators like OpenRouter / openCodeGo / openAICompatible / liteLLM are NOT in this set
 * because vision support is per-model, not per-provider. Use catalog-driven `supportsVision`
 * overrides (set by RemoteCatalogService) to flag individual aggregator models.
 */
const VISION_PROVIDERS: ProviderName[] = ['anthropic', 'openAI', 'gemini', 'pollinations'];

/**
 * Aggregator providers — vision capability is per-model, decided by catalog override or model-name heuristic.
 */
// `minimax` is the native (OpenAI-compatible) endpoint serving both text-only and multimodal
// models, so vision is per-model — treat it like an aggregator and decide by name heuristic.
const AGGREGATOR_PROVIDERS: ProviderName[] = ['openRouter', 'openCodeGo', 'openCodeZen', 'openAICompatible', 'liteLLM', 'minimax'];

const heuristicWarnedSet = new Set<string>();

function aggregatorVisionHeuristic(providerName: ProviderName, modelName: string): boolean {
	const matched = isVisionByNameHeuristic(modelName);
	if (matched) {
		const key = `${providerName}/${modelName}`;
		if (!heuristicWarnedSet.has(key)) {
			heuristicWarnedSet.add(key);
			vibeLog.warn('visionModelHelper', `vision capability for ${key} resolved by name heuristic — no catalog override available. If this is wrong, set supportsVision on the model entry.`);
		}
	}
	return matched;
}

/**
 * Reads the catalog-driven `supportsVision` override for a given model, if any.
 * Returns undefined when no override is recorded (caller falls through to heuristics).
 */
function readSupportsVisionOverride(overridesOfModel: OverridesOfModel | undefined, providerName: ProviderName, modelName: string): boolean | undefined {
	const v = overridesOfModel?.[providerName]?.[modelName]?.supportsVision;
	return typeof v === 'boolean' ? v : undefined;
}

/**
 * Checks if user has any vision-capable API keys configured.
 * Includes: native vision providers (Anthropic, OpenAI, Gemini, Pollinations), and aggregators
 * (OpenRouter, openCodeGo, openAICompatible, liteLLM) when they have at least one enabled model
 * flagged `supportsVision=true` in catalog overrides or matching the heuristic.
 */
export function hasVisionCapableApiKey(settingsOfProvider: SettingsOfProvider, currentModelSelection: ModelSelection | null, overridesOfModel?: OverridesOfModel): boolean {
	// Check current model selection first (only if not auto mode)
	if (currentModelSelection) {
		const { providerName } = currentModelSelection;
		// Skip "auto" - it's not a real provider, but we still want to check all providers below
		if (providerName !== 'auto' && VISION_PROVIDERS.includes(providerName)) {
			const providerSettings = settingsOfProvider[providerName];
			if (providerSettings.apiKey && providerSettings.apiKey.length > 10) {
				return true;
			}
		}
	}

	// Check all native vision providers
	for (const providerName of VISION_PROVIDERS) {
		const providerSettings = settingsOfProvider[providerName];
		if (providerSettings.apiKey && providerSettings.apiKey.length > 10) {
			// Check if provider has at least one enabled model
			const hasEnabledModel = providerSettings.models.some(m => !m.isHidden);
			if (hasEnabledModel) {
				return true;
			}
		}
	}

	// Aggregators: vision is per-model — accept only when at least one enabled model is flagged or matches heuristic
	for (const providerName of AGGREGATOR_PROVIDERS) {
		const providerSettings = settingsOfProvider[providerName];
		if (!providerSettings.apiKey || providerSettings.apiKey.length <= 10) { continue; }
		const hasVisionModel = providerSettings.models.some(m => {
			if (m.isHidden) { return false; }
			const override = readSupportsVisionOverride(overridesOfModel, providerName, m.modelName);
			if (typeof override === 'boolean') { return override; }
			return aggregatorVisionHeuristic(providerName, m.modelName);
		});
		if (hasVisionModel) { return true; }
	}

	return false;
}

/**
 * Checks if a specific model name is a vision model
 */
export function isVisionModelName(modelName: string): boolean {
	const name = modelName.toLowerCase();
	const visionModelNames = ['llava', 'bakllava', 'llama-vision', 'qwen-vl'];
	return visionModelNames.some(vm => name.includes(vm));
}

/**
 * Checks if Ollama is installed and has vision models
 */
export async function hasOllamaVisionModel(): Promise<boolean> {
	try {
		const res = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
		if (!res.ok) { return false; }
		const data = await res.json() as { models?: { name?: string }[] };
		const models = data.models || [];
		// Check for common vision model names
		// Ollama API returns models with 'name' field
		return models.some(m => {
			const name = (m.name || '').toLowerCase();
			return isVisionModelName(name);
		});
	} catch {
		return false;
	}
}

/**
 * Checks if a specific Ollama model is vision-capable by querying Ollama API
 */
export async function checkOllamaModelVisionCapable(modelName: string): Promise<boolean> {
	try {
		// Query Ollama to get model details
		const res = await fetch(`http://127.0.0.1:11434/api/show`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: modelName }),
		});
		if (!res.ok) { return false; }
		const modelInfo = await res.json();
		// Check if model has vision capabilities in its details
		// Ollama vision models typically have "multimodal" or "vision" in details
		const details = JSON.stringify(modelInfo).toLowerCase();
		return details.includes('vision') || details.includes('multimodal') || isVisionModelName(modelName);
	} catch {
		// If API call fails, fall back to name-based detection
		return isVisionModelName(modelName);
	}
}

/**
 * Checks if the currently selected model is a vision-capable model.
 * Order: catalog-driven `supportsVision` override → native-vision provider → aggregator heuristic → Ollama vision-name match.
 */
export function isSelectedModelVisionCapable(currentModelSelection: ModelSelection | null, settingsOfProvider: SettingsOfProvider, overridesOfModel?: OverridesOfModel): boolean {
	if (!currentModelSelection) { return false; }

	const { providerName, modelName } = currentModelSelection;

	// Skip "auto" - it's not a real provider
	if (providerName === 'auto') { return false; }

	// Unified capability resolution (hardcoded modelOptions → name recognition for claude/gpt/gemini/
	// minimax/… → catalog hint → user override): covers built-ins AND dynamic providers (.vibe/providers
	// .json) through the SAME registry. A definitive boolean is authoritative; `undefined` (model the
	// registry can't classify) falls through to the legacy provider-set heuristics below.
	const caps = getModelCapabilities(providerName, modelName, overridesOfModel);
	if (typeof caps.supportsVision === 'boolean') { return caps.supportsVision; }

	// Check if it's a vision-capable API provider with a valid key
	if (VISION_PROVIDERS.includes(providerName)) {
		const providerSettings = settingsOfProvider[providerName];
		if (providerSettings.apiKey && providerSettings.apiKey.length > 10) {
			// Check if the selected model is actually available (not hidden)
			const modelExists = providerSettings.models.some(m =>
				m.modelName === modelName && !m.isHidden
			);
			if (modelExists) {
				return true;
			}
		}
	}

	// Aggregator providers: per-model heuristic on the model name (used when catalog hasn't been fetched yet).
	if (AGGREGATOR_PROVIDERS.includes(providerName)) {
		const providerSettings = settingsOfProvider[providerName];
		if (providerSettings.apiKey && providerSettings.apiKey.length > 10) {
			return aggregatorVisionHeuristic(providerName, modelName);
		}
	}

	// Check if it's an Ollama vision model
	// Model names can be like "llava", "llava:latest", "llava:7b", etc.
	if (providerName === 'ollama') {
		const providerSettings = settingsOfProvider[providerName];
		const baseModelName = modelName.split(':')[0].toLowerCase();

		// First check if the model name itself contains vision keywords
		if (isVisionModelName(modelName)) {
			// If model name contains vision keywords, trust it's a vision model
			// (Ollama models are auto-detected, might not be in settings immediately)
			return true;
		}

		// Check if any model in settings matches (might be stored with different tag)
		const matchingModel = providerSettings.models.find(m => {
			if (m.isHidden) { return false; }
			// Check exact match or if base names match
			const modelBaseName = m.modelName.split(':')[0].toLowerCase();
			if (m.modelName === modelName || modelBaseName === baseModelName) {
				// If it's a vision model in settings, return it
				return isVisionModelName(m.modelName);
			}
			return false;
		});
		if (matchingModel) {
			return true;
		}
	}

	return false;
}

/**
 * Checks if Ollama service is accessible
 */
export async function isOllamaAccessible(): Promise<boolean> {
	try {
		const res = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
		return res.ok;
	} catch {
		return false;
	}
}
