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
export function normaliseCatalogCost(rawInput: unknown, rawOutput: unknown): { input: number; output: number } | undefined {
	const input = perMillionFromPerToken(rawInput);
	const output = perMillionFromPerToken(rawOutput);
	if (input === undefined || output === undefined) { return undefined; }
	return { input, output };
}
