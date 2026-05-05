/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { SettingsOfProvider, ModelSelection, ProviderName } from '../../../../common/vibeideSettingsTypes.js';

/**
 * Vision-capable providers that require API keys
 */
const VISION_PROVIDERS: ProviderName[] = ['anthropic', 'openAI', 'gemini', 'pollinations'];

/**
 * Checks if user has any vision-capable API keys configured
 */
export function hasVisionCapableApiKey(settingsOfProvider: SettingsOfProvider, currentModelSelection: ModelSelection | null): boolean {
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

	// Check all vision-capable providers (always check this, especially for auto mode)
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
		if (!res.ok) return false;
		const data = await res.json();
		const models = data.models || [];
		// Check for common vision model names
		// Ollama API returns models with 'name' field
		return models.some((m: any) => {
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
		if (!res.ok) return false;
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
 * Checks if the currently selected model is a vision-capable model
 */
export function isSelectedModelVisionCapable(currentModelSelection: ModelSelection | null, settingsOfProvider: SettingsOfProvider): boolean {
	if (!currentModelSelection) return false;

	const { providerName, modelName } = currentModelSelection;

	// Skip "auto" - it's not a real provider
	if (providerName === 'auto') return false;

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
			if (m.isHidden) return false;
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
