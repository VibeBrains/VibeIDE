/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getModelCapabilities } from './modelCapabilities.js';
import { costOf } from './spendLedger.js';
import type { OverridesOfModel } from './vibeideSettingsTypes.js';
import type { SubagentResult } from './vibeSubagentService.js';

/**
 * Approximate USD cost of a subagent run from the provider-reported token sums and the STATIC
 * pricing table (USD per 1M tokens). Returns undefined when the price is unknown ({0,0} in the
 * table means «no price», not «free») or when the run carried no model/usage info.
 *
 * One formula for money — the ledger's: this file used to keep its own, which ignored the prompt
 * cache and billed cached tokens at the full input rate.
 *
 * Deliberately does NOT pass catalogInfo to getModelCapabilities: remote-catalog cost fields are
 * per-token (LiteLLM/OpenRouter), i.e. 1e6× off the static per-1M scale — see roadmap debt item.
 */
export function subagentCostUsd(result: Pick<SubagentResult, 'providerName' | 'modelName' | 'promptTokensUsed' | 'completionTokensUsed' | 'cachedTokensUsed'>, overrides: OverridesOfModel | undefined): number | undefined {
	if (!result.providerName || !result.modelName) { return undefined; }
	if (!result.promptTokensUsed && !result.completionTokensUsed) { return undefined; }
	return costOf(getModelCapabilities(result.providerName, result.modelName, overrides).cost, {
		input: result.promptTokensUsed ?? 0,
		output: result.completionTokensUsed ?? 0,
		cacheRead: result.cachedTokensUsed ?? 0,
	});
}

/** Compact money formatting: cents get 2 decimals, sub-cent amounts keep 4. */
export function formatUsd(usd: number): string {
	return usd >= 0.1 ? usd.toFixed(2) : usd.toFixed(4);
}
