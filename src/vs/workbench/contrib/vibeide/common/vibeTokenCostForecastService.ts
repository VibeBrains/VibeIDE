/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface TokenCostForecast {
	worstCaseUsd: number;
	withCacheUsd: number;
	estimatedInputTokens: number;
	estimatedOutputTokens: number;
	currency: 'USD';
	confidence: 'low' | 'medium' | 'high';
}

export interface ModelPricing {
	inputPer1kTokens: number;   // USD
	outputPer1kTokens: number;  // USD
	cacheReadDiscount: number;  // 0-1, e.g. 0.9 = 90% discount on cached reads
}

export const IVibeTokenCostForecastService = createDecorator<IVibeTokenCostForecastService>('vibeTokenCostForecastService');

export interface IVibeTokenCostForecastService {
	readonly _serviceBrand: undefined;

	/** Estimate cost before sending a request */
	forecast(inputText: string, modelId: string): TokenCostForecast;

	/** Record actual usage for improving future forecasts */
	recordActual(modelId: string, inputTokens: number, outputTokens: number, cachedTokens: number): void;

	/** Get pricing for a model (from built-in table or models.json) */
	getPricing(modelId: string): ModelPricing | null;
}

// Built-in pricing table (updated manually — Phase 2 will load from models.json CDN)
const PRICING_TABLE: Record<string, ModelPricing> = {
	'claude-3-5-sonnet': { inputPer1kTokens: 0.003, outputPer1kTokens: 0.015, cacheReadDiscount: 0.9 },
	'claude-3-5-haiku': { inputPer1kTokens: 0.0008, outputPer1kTokens: 0.004, cacheReadDiscount: 0.9 },
	'claude-3-opus': { inputPer1kTokens: 0.015, outputPer1kTokens: 0.075, cacheReadDiscount: 0.9 },
	'gpt-4o': { inputPer1kTokens: 0.0025, outputPer1kTokens: 0.01, cacheReadDiscount: 0.5 },
	'gpt-4o-mini': { inputPer1kTokens: 0.00015, outputPer1kTokens: 0.0006, cacheReadDiscount: 0.5 },
	'gemini-1.5-pro': { inputPer1kTokens: 0.00125, outputPer1kTokens: 0.005, cacheReadDiscount: 0.75 },
	'gemini-1.5-flash': { inputPer1kTokens: 0.000075, outputPer1kTokens: 0.0003, cacheReadDiscount: 0.75 },
};

// Rough tokens-per-char estimate (varies by model/language, but ~0.25 is typical for English)
const CHARS_PER_TOKEN = 4;
// Typical output-to-input ratio for code generation
const OUTPUT_RATIO = 0.5;

class VibeTokenCostForecastService extends Disposable implements IVibeTokenCostForecastService {
	declare readonly _serviceBrand: undefined;

	// Models we've already logged a "no pricing" miss for — log once each, not per
	// forecast call (the forecast runs on every turn, so an unpriced model like
	// minimax-m2.7 otherwise repeats the same debug line throughout the session).
	private readonly _loggedNoPricing = new Set<string>();

	constructor(
	) {
		super();
	}

	forecast(inputText: string, modelId: string): TokenCostForecast {
		const pricing = this.getPricing(modelId);
		const estimatedInputTokens = Math.ceil(inputText.length / CHARS_PER_TOKEN);
		const estimatedOutputTokens = Math.ceil(estimatedInputTokens * OUTPUT_RATIO);

		if (!pricing) {
			if (!this._loggedNoPricing.has(modelId)) {
				this._loggedNoPricing.add(modelId);
				vibeLog.debug('CostForecast', `No pricing for model: ${modelId} (cost forecast disabled for it)`);
			}
			return {
				worstCaseUsd: 0,
				withCacheUsd: 0,
				estimatedInputTokens,
				estimatedOutputTokens,
				currency: 'USD',
				confidence: 'low',
			};
		}

		const worstCaseUsd =
			(estimatedInputTokens / 1000) * pricing.inputPer1kTokens +
			(estimatedOutputTokens / 1000) * pricing.outputPer1kTokens;

		const cachedInputCost = (estimatedInputTokens / 1000) * pricing.inputPer1kTokens * (1 - pricing.cacheReadDiscount);
		const withCacheUsd = cachedInputCost + (estimatedOutputTokens / 1000) * pricing.outputPer1kTokens;

		return {
			worstCaseUsd: Math.round(worstCaseUsd * 10000) / 10000,
			withCacheUsd: Math.round(withCacheUsd * 10000) / 10000,
			estimatedInputTokens,
			estimatedOutputTokens,
			currency: 'USD',
			confidence: 'medium',
		};
	}

	recordActual(modelId: string, inputTokens: number, outputTokens: number, cachedTokens: number): void {
		const pricing = this.getPricing(modelId);
		if (!pricing) { return; }

		const actualCost =
			((inputTokens - cachedTokens) / 1000) * pricing.inputPer1kTokens +
			(cachedTokens / 1000) * pricing.inputPer1kTokens * (1 - pricing.cacheReadDiscount) +
			(outputTokens / 1000) * pricing.outputPer1kTokens;

		vibeLog.debug('CostForecast', `Actual cost for ${modelId}: $${actualCost.toFixed(4)} (in:${inputTokens} out:${outputTokens} cached:${cachedTokens})`);
	}

	getPricing(modelId: string): ModelPricing | null {
		// Try exact match first
		if (PRICING_TABLE[modelId]) { return PRICING_TABLE[modelId]; }

		// Try partial match (e.g., 'claude-3-5-sonnet-20241022' → 'claude-3-5-sonnet')
		const entry = Object.entries(PRICING_TABLE).find(([key]) =>
			modelId.toLowerCase().includes(key) || key.includes(modelId.toLowerCase())
		);
		return entry?.[1] ?? null;
	}
}

registerSingleton(IVibeTokenCostForecastService, VibeTokenCostForecastService, InstantiationType.Eager);
