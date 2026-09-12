/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Brings catalog prices to the one unit the rest of VibeIDE speaks: dollars per MILLION tokens.
 *
 * WHY: aggregators quote per single token — LiteLLM `input_cost_per_token: 0.000003`, OpenRouter
 * `pricing.prompt: "0.000003"` — while our static table and everything reading it (spend ledger,
 * cost forecast, router's cheap/expensive tiers) are per million. Passing the raw number through
 * made a catalog model look a million times cheaper than it is: the router treats it as free and
 * routes there, the spend panel reports pennies for dollars.
 *
 * OpenRouter also sends prices as STRINGS. The previous code did `pricing.prompt || 0`, so a string
 * survived into a numeric field and any arithmetic on it produced garbage rather than an error.
 *
 * Pure: numbers in, numbers out. No I/O, no service graph.
 */

import { ModelCost, ModelLongContext } from './modelCapabilities.js';

/**
 * Sanity ceiling, in dollars per million tokens. The most expensive models of 2026 sit near $75/M;
 * anything above this is a unit mix-up rather than a real price, and a wrong price is worse than a
 * missing one — a missing price is reported as "unknown", a wrong one is silently trusted.
 */
const MAX_PLAUSIBLE_PER_MILLION = 1_000;

/** Parses a price that may arrive as a number or a numeric string. Returns undefined for anything else. */
export function parseCatalogPrice(raw: unknown): number | undefined {
	if (typeof raw === 'number') {
		return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
	}
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (!trimmed) { return undefined; }
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

/**
 * Per-token price → per-million, or undefined when the input is unusable.
 *
 * Zero is passed through rather than dropped: a catalog that says a model is free is making a
 * statement, and local providers (ollama, LM Studio) genuinely are.
 */
export function perMillionFromPerToken(raw: unknown): number | undefined {
	const perToken = parseCatalogPrice(raw);
	if (perToken === undefined) { return undefined; }
	const perMillion = perToken * 1_000_000;
	return perMillion <= MAX_PLAUSIBLE_PER_MILLION ? perMillion : undefined;
}

/**
 * Both sides of a catalog price, normalised together.
 *
 * All-or-nothing on purpose: a pair where one side survived and the other was dropped would be
 * reported as "input costs $3/M, output is free", which reads as a bargain instead of as missing
 * data. Undefined means "the catalog did not tell us", and callers already render that honestly.
 */
export function normaliseCatalogCost(rawInput: unknown, rawOutput: unknown, extras?: CatalogCostExtras): ModelCost | undefined {
	const input = perMillionFromPerToken(rawInput);
	const output = perMillionFromPerToken(rawOutput);
	if (input === undefined || output === undefined) { return undefined; }
	const cost: ModelCost = { input, output };
	const cacheRead = perMillionFromPerToken(extras?.cacheRead);
	const cacheWrite = perMillionFromPerToken(extras?.cacheWrite);
	if (cacheRead !== undefined) { cost.cache_read = cacheRead; }
	if (cacheWrite !== undefined) { cost.cache_write = cacheWrite; }
	const longContext = longContextFromOverrides(cost, extras?.overrides);
	if (longContext) { cost.long_context = longContext; }
	return cost;
}

/** The catalog fields that live beside the two base rates. All optional: most catalogs send none of them. */
export type CatalogCostExtras = {
	cacheRead?: unknown;
	cacheWrite?: unknown;
	/** OpenRouter's `pricing.overrides` — a list of tiers, each replacing the rates under its own condition. */
	overrides?: unknown;
};

/**
 * OpenRouter's long-prompt tier, converted to the multipliers our `ModelCost` speaks.
 *
 * WHY a conversion at all: the catalog states the tier as ABSOLUTE rates ("past 272 000 prompt
 * tokens, input costs $0.00001/token"), while our price carries FACTORS over the base rates,
 * because that is how the static profiles and the spend ledger were built. Dividing here keeps
 * one representation in the codebase instead of two that drift.
 *
 * Only tiers keyed by `min_prompt_tokens` are read. The same list also carries time-based entries
 * (`utc_days`, `utc_start`/`utc_end` — off-peak discounts): those depend on the clock at request
 * time, which the ledger prices after the fact, and a discount misread as a surcharge is worse than
 * no tier at all. When several prompt tiers are listed we take the LOWEST threshold — our type
 * holds one step, and the first step is the one nearly every request that crosses it lands on.
 */
export function longContextFromOverrides(base: ModelCost, rawOverrides: unknown): ModelLongContext | undefined {
	if (!Array.isArray(rawOverrides)) { return undefined; }
	let best: { threshold: number; entry: Record<string, unknown> } | undefined;
	for (const raw of rawOverrides) {
		if (!raw || typeof raw !== 'object') { continue; }
		const entry = raw as Record<string, unknown>;
		const threshold = typeof entry.min_prompt_tokens === 'number' ? entry.min_prompt_tokens : undefined;
		if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) { continue; }
		if (!best || threshold < best.threshold) { best = { threshold, entry }; }
	}
	if (!best) { return undefined; }
	const factor = (raw: unknown, baseRate: number | undefined): number | undefined => {
		const tierRate = perMillionFromPerToken(raw);
		if (tierRate === undefined || baseRate === undefined || baseRate <= 0) { return undefined; }
		return tierRate / baseRate;
	};
	const input = factor(best.entry.prompt, base.input);
	const output = factor(best.entry.completion, base.output);
	const cache = factor(best.entry.input_cache_read, base.cache_read ?? base.input);
	// Every factor at 1 (or unreadable) means the tier changes nothing — say nothing rather than
	// carry a step that only costs a comparison on every priced exchange.
	if ((input ?? 1) === 1 && (output ?? 1) === 1 && (cache ?? 1) === 1) { return undefined; }
	const tier: ModelLongContext = { over_input_tokens: best.threshold };
	if (input !== undefined) { tier.input = input; }
	if (output !== undefined) { tier.output = output; }
	if (cache !== undefined) { tier.cache = cache; }
	return tier;
}
