/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ProviderName, ModelSelection, OverridesOfModel, localProviderNames } from './vibeideSettingsTypes.js';
import { getModelCapabilities, VibeideStaticModelInfo } from './modelCapabilities.js';

/**
 * Normalized capability profile for a model
 */
export interface ModelCapabilityProfile {
	modelSelection: ModelSelection;

	// Strengths (0-1 normalized scores)
	strengths: {
		codeEdit: number; // inline code editing
		codeReasoning: number; // codebase understanding, analysis
		generalQA: number; // general Q&A
		vision: number; // image understanding
		pdf: number; // PDF/document understanding
		longContext: number; // large context window handling
	};

	// Weaknesses (0-1 normalized scores)
	weaknesses: {
		codeEdit?: number;
		codeReasoning?: number;
		generalQA?: number;
		vision?: number;
		pdf?: number;
		longContext?: number;
	};

	// Cost tier: 'free' | 'low' | 'medium' | 'high' | 'premium'
	costTier: string;

	// Latency band: 'low' | 'medium' | 'high'
	latencyBand: string;

	// Privacy: true if local/offline capable
	isLocal: boolean;

	// Context window in tokens
	contextWindow: number;

	// Raw capabilities for reference
	rawCapabilities: VibeideStaticModelInfo;
}

/**
 * Registry for normalized model capability profiles
 */
export class ModelCapabilityRegistry {
	private profiles: Map<string, ModelCapabilityProfile> = new Map();

	/**
	 * Get or create capability profile for a model
	 */
	getProfile(
		modelSelection: ModelSelection,
		overridesOfModel?: OverridesOfModel
	): ModelCapabilityProfile {
		const key = `${modelSelection.providerName}:${modelSelection.modelName}`;

		if (this.profiles.has(key)) {
			return this.profiles.get(key)!;
		}

		// Skip 'auto' provider - return default profile
		if (modelSelection.providerName === 'auto') {
			// Return a default profile for 'auto'
			return this.computeProfile(
				modelSelection,
				{
					contextWindow: 4_096,
					reservedOutputTokenSpace: 4_096,
					cost: { input: 0, output: 0 },
					downloadable: false,
					supportsSystemMessage: false,
					supportsFIM: false,
					reasoningCapabilities: false,
				}
			);
		}

		const rawCapabilities = getModelCapabilities(
			modelSelection.providerName as ProviderName,
			modelSelection.modelName,
			overridesOfModel
		);

		const profile = this.computeProfile(modelSelection, rawCapabilities);
		this.profiles.set(key, profile);
		return profile;
	}

	/**
	 * Compute normalized capability profile from raw capabilities
	 */
	private computeProfile(
		modelSelection: ModelSelection,
		capabilities: VibeideStaticModelInfo
	): ModelCapabilityProfile {
		const name = modelSelection.modelName.toLowerCase();
		const provider = modelSelection.providerName.toLowerCase();
		const isLocal = (localProviderNames as readonly ProviderName[]).includes(modelSelection.providerName as ProviderName);

		// Compute strengths (0-1 scale)
		const strengths = {
			codeEdit: this.computeCodeEditStrength(provider, name, capabilities),
			codeReasoning: this.computeCodeReasoningStrength(provider, name, capabilities),
			generalQA: this.computeGeneralQAStrength(provider, name, capabilities),
			vision: this.computeVisionStrength(provider, name, capabilities),
			pdf: this.computePDFStrength(provider, name, capabilities),
			longContext: this.computeLongContextStrength(capabilities),
		};

		// Compute weaknesses (inverse of strengths, but only if significant)
		const weaknesses: ModelCapabilityProfile['weaknesses'] = {};
		if (strengths.codeEdit < 0.3) { weaknesses.codeEdit = 1 - strengths.codeEdit; }
		if (strengths.codeReasoning < 0.3) { weaknesses.codeReasoning = 1 - strengths.codeReasoning; }
		if (strengths.generalQA < 0.3) { weaknesses.generalQA = 1 - strengths.generalQA; }
		if (strengths.vision < 0.3) { weaknesses.vision = 1 - strengths.vision; }
		if (strengths.pdf < 0.3) { weaknesses.pdf = 1 - strengths.pdf; }
		if (strengths.longContext < 0.3) { weaknesses.longContext = 1 - strengths.longContext; }

		// Cost tier
		const costPerM = (capabilities.cost.input + capabilities.cost.output) / 2;
		let costTier: string;
		if (costPerM === 0) {
			costTier = 'free';
		} else if (costPerM < 1) {
			costTier = 'low';
		} else if (costPerM < 5) {
			costTier = 'medium';
		} else if (costPerM < 15) {
			costTier = 'high';
		} else {
			costTier = 'premium';
		}

		// Latency band (heuristic based on model name and size)
		let latencyBand: string;
		if (name.includes('mini') || name.includes('fast') || name.includes('haiku') || name.includes('nano') || name.includes('flash')) {
			latencyBand = 'low';
		} else if (name.includes('opus') || name.includes('ultra') || name.includes('o1') || (name.includes('o3') && name.includes('mini'))) {
			latencyBand = 'high';
		} else {
			latencyBand = 'medium';
		}

		return {
			modelSelection,
			strengths,
			weaknesses,
			costTier,
			latencyBand,
			isLocal,
			contextWindow: capabilities.contextWindow,
			rawCapabilities: capabilities,
		};
	}

	private computeCodeEditStrength(provider: string, name: string, capabilities: VibeideStaticModelInfo): number {
		let score = 0;

		// FIM support is critical for code editing
		if (capabilities.supportsFIM) { score += 0.4; }

		// Code-tuned models
		if (name.includes('code') || name.includes('coder') || name.includes('devstral') || name.includes('codestral')) {
			score += 0.3;
		}

		// High-quality models are good at code generation
		if (provider === 'anthropic' && (name.includes('3.5') || name.includes('4') || name.includes('opus') || name.includes('sonnet'))) {
			score += 0.2;
		} else if (provider === 'openai' && (name.includes('4o') || name.includes('4.1') || name.includes('gpt-4'))) {
			score += 0.2;
		}

		// Local code models can be decent
		if (name.includes('deepseek') || name.includes('qwen') || name.includes('codellama')) {
			score += 0.1;
		}

		return Math.min(1.0, score);
	}

	private computeCodeReasoningStrength(provider: string, name: string, capabilities: VibeideStaticModelInfo): number {
		let score = 0;

		// Large context is critical for codebase reasoning
		if (capabilities.contextWindow >= 200_000) { score += 0.3; }
		else if (capabilities.contextWindow >= 128_000) { score += 0.25; }
		else if (capabilities.contextWindow >= 64_000) { score += 0.15; }

		// Reasoning capabilities
		if (capabilities.reasoningCapabilities && typeof capabilities.reasoningCapabilities === 'object' && capabilities.reasoningCapabilities.supportsReasoning) {
			score += 0.3;
		}

		// Top-tier models excel at codebase analysis
		if (provider === 'anthropic' && (name.includes('4') || name.includes('opus') || name.includes('3.5') || name.includes('sonnet'))) {
			score += 0.25;
		} else if (provider === 'openai' && (name.includes('4o') || name.includes('4.1') || name.includes('gpt-4'))) {
			score += 0.25;
		}

		return Math.min(1.0, score);
	}

	private computeGeneralQAStrength(provider: string, name: string, capabilities: VibeideStaticModelInfo): number {
		let score = 0.5; // Baseline

		// High-quality models are better at general Q&A
		if (provider === 'anthropic' && (name.includes('3.5') || name.includes('4') || name.includes('opus') || name.includes('sonnet'))) {
			score += 0.3;
		} else if (provider === 'openai' && (name.includes('4o') || name.includes('4.1') || name.includes('gpt-4'))) {
			score += 0.3;
		} else if (provider === 'gemini' && (name.includes('pro') || name.includes('ultra'))) {
			score += 0.25;
		}

		// Reasoning helps with complex Q&A
		if (capabilities.reasoningCapabilities && typeof capabilities.reasoningCapabilities === 'object' && capabilities.reasoningCapabilities.supportsReasoning) {
			score += 0.15;
		}

		return Math.min(1.0, score);
	}

	private computeVisionStrength(provider: string, name: string, capabilities: VibeideStaticModelInfo): number {
		// Check if model supports vision
		if (provider === 'gemini') { return 0.9; } // All Gemini models support vision
		if (provider === 'anthropic' && (name.includes('3.5') || name.includes('3.7') || name.includes('4') || name.includes('opus') || name.includes('sonnet'))) {
			return 0.9;
		}
		if (provider === 'openai' && (name.includes('4o') || name.includes('4.1') || name.includes('gpt-4'))) {
			return 0.9;
		}
		if ((provider === 'ollama' || provider === 'vllm') && (name.includes('llava') || name.includes('bakllava') || name.includes('vision'))) {
			return 0.6; // Local vision models are weaker
		}
		return 0.0;
	}

	private computePDFStrength(provider: string, name: string, capabilities: VibeideStaticModelInfo): number {
		// PDF requires vision + large context + good reasoning
		const visionStrength = this.computeVisionStrength(provider, name, capabilities);
		if (visionStrength === 0) { return 0; }

		let score = visionStrength * 0.5; // Base on vision capability

		// Large context helps with multi-page PDFs
		if (capabilities.contextWindow >= 200_000) { score += 0.3; }
		else if (capabilities.contextWindow >= 128_000) { score += 0.2; }

		// Reasoning helps understand document structure
		if (capabilities.reasoningCapabilities && typeof capabilities.reasoningCapabilities === 'object' && capabilities.reasoningCapabilities.supportsReasoning) {
			score += 0.2;
		}

		return Math.min(1.0, score);
	}

	private computeLongContextStrength(capabilities: VibeideStaticModelInfo): number {
		if (capabilities.contextWindow >= 200_000) { return 1.0; }
		if (capabilities.contextWindow >= 128_000) { return 0.8; }
		if (capabilities.contextWindow >= 64_000) { return 0.6; }
		if (capabilities.contextWindow >= 32_000) { return 0.4; }
		return 0.2;
	}
}

