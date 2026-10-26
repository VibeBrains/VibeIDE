/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { providerVendorKey } from './providerVendor.js';


/**
 * Single source of truth for name-based vision capability detection on aggregator providers
 * (OpenRouter, OpenCode, openCodeZen, openAICompatible, liteLLM, Pollinations) when no
 * authoritative catalog flag is available. Used by both chatThreadService and visionModelHelper —
 * keeping the list in one place avoids drift like the one that re-blocked nemotron-omni.
 *
 * Conservative: only well-known vision-model markers — anything else stays false to avoid
 * silently sending images into a text-only model. If a future text-only model includes one
 * of these tokens in its id, set an explicit `supportsVision: false` override on the entry.
 */
export const VISION_NAME_SUBSTRINGS: readonly string[] = [
	'vision', '-vl', 'vl-', 'llava', 'bakllava', 'pixtral',
	'claude-3', 'claude-4', 'claude-sonnet', 'claude-opus',
	'gpt-4o', 'gpt-4.1', 'gpt-5', 'gemini',
	'qwen2-vl', 'qwen2.5-vl', 'qwen3-vl',
	// Extended coverage for OpenCode / OpenRouter / openAICompatible catalogs that don't surface modality metadata.
	// IMPORTANT: only well-known *vision* markers. Do NOT add generic tokens like `omni` or `multimodal` —
	// many "omni" models (e.g. nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free) advertise multimodality
	// in OpenRouter's catalog but in practice do not accept image input on the free tier, leading to
	// silent text-only execution and hallucinated descriptions of the system prompt.
	// MiniMax: VL series (legacy vision) + M3 (native multimodal — text/image/video in).
	// M1/M2/M2.x are text-only — do NOT add them.
	'minimax-vl', 'minimax-m3',
	'glm-4v', 'glm-4.5v',
	'kimi-vl',
	'internvl', 'cogvlm',
	'phi-3.5-vision', 'phi-4-vision',
	'nova-pro', 'nova-lite',
	'step-1v',
];

export function isVisionByNameHeuristic(modelName: string): boolean {
	const lower = modelName.toLowerCase();
	return VISION_NAME_SUBSTRINGS.some(s => lower.includes(s));
}

/**
 * Authoritative vision-capability decision for a concrete model selection.
 * Order: catalog-driven `supportsVision` (when set) → per-provider knowledge → the shared
 * name-substring heuristic above. Single source of truth reused by chatThreadService (image-attach
 * gate) and vibeSubagentRunnerService (vision-role model fallback, звено 3) so the two never drift.
 *
 * @param capabilities Model capabilities from `getModelCapabilities` — only `supportsVision` is read.
 *   An explicit boolean is authoritative; `undefined` falls through to heuristics.
 */
export function isModelVisionCapable(
	modelSelection: { readonly providerName: string; readonly modelName: string },
	capabilities?: { readonly supportsVision?: boolean },
): boolean {
	// Authoritative when set: catalog-derived flag (OpenRouter, openAICompatible, etc.).
	if (capabilities && typeof capabilities.supportsVision === 'boolean') {
		return capabilities.supportsVision;
	}

	const name = modelSelection.modelName.toLowerCase();
	const provider = providerVendorKey(modelSelection.providerName);

	if (provider === 'gemini') { return true; } // all Gemini models support vision
	if (provider === 'anthropic') {
		return name.includes('3.5') || name.includes('3.7') || name.includes('4') || name.includes('opus') || name.includes('sonnet');
	}
	if (provider === 'openai') {
		if (name.includes('gpt-5') || name.includes('gpt-5.1')) { return true; }
		if (name.includes('4.1')) { return true; }
		if (name.includes('4o')) { return true; }
		if (name.startsWith('o1') || name.startsWith('o3') || name.startsWith('o4')) { return true; }
		if (name.includes('gpt-4')) { return true; }
	}
	if (provider === 'mistral') {
		if (name.includes('pixtral')) { return true; }
	}
	if (provider === 'ollama' || provider === 'vllm') {
		return name.includes('llava') || name.includes('bakllava') || name.includes('vision');
	}
	// Aggregators / OpenAI-compatible without a catalog flag → shared substring whitelist.
	// `minimax` serves both text-only (M2) and multimodal (M3) models → vision is per-model.
	if (provider === 'openrouter' || provider === 'opencode' || provider === 'opencodezen' || provider === 'openaicompatible' || provider === 'litellm' || provider === 'pollinations' || provider === 'minimax') {
		if (isVisionByNameHeuristic(modelSelection.modelName)) { return true; }
	}

	return false;
}
