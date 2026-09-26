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
import type { PriceTimeOfDay } from './modelPriceSchedule.js';

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
	// The catalogue quotes the OFF-peak rate as the base and raises it inside the peak windows, while our
	// price carries PEAK rates and a factor below one — the shape the providers file and the ledger speak.
	const hour = timeOfDayFromOverrides(cost, extras?.overrides);
	if (hour) {
		cost.input = hour.peak.input;
		cost.output = hour.peak.output;
		if (hour.peak.cacheRead !== undefined) { cost.cache_read = hour.peak.cacheRead; }
		cost.time_of_day = hour.schedule;
	}
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
 * Only tiers keyed by `min_prompt_tokens` are read here; the time-based entries of the same list
 * (`utc_days`, `utc_start`/`utc_end`) are the hour schedule — see `timeOfDayFromOverrides`.
 * When several prompt tiers are listed we take the LOWEST threshold — our type
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

const UTC_DAY_NUMBERS: Readonly<Record<string, number>> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
/** Factors are compared after rounding: per-token strings times a million are not exact in floating point. */
const FACTOR_PRECISION = 1e6;

function roundFactor(value: number): number {
	return Math.round(value * FACTOR_PRECISION) / FACTOR_PRECISION;
}

/** `HHMM` as OpenRouter writes it (`100` = 01:00, `0` as an end = midnight) → minutes since midnight. */
function minutesOfUtcHhmm(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2400) { return undefined; }
	const hours = Math.floor(value / 100);
	const minutes = value % 100;
	return minutes < 60 && (hours < 24 || value === 2400) ? (hours * 60 + minutes) % (24 * 60) : undefined;
}

/**
 * OpenRouter's hour schedule (`pricing.overrides` entries with `utc_days` / `utc_start` / `utc_end`),
 * converted to our peak rates plus `time_of_day`.
 *
 * WHY: DeepSeek via OpenRouter bills twice the base rate on weekdays 01:00–04:00 and 06:00–10:00 UTC
 * (catalogue checked 17.09.2026). Dropping these entries priced every peak turn at half its cost.
 *
 * Peak windows are the entries whose rates are ABOVE the base. They must agree — one factor for every
 * rate they state, and one set of days — because our schedule holds one factor and one day list. A
 * schedule that does not fit that shape is not approximated: an estimate that looks exact and is wrong
 * is worse than the base rate the catalogue itself calls the price.
 */
export function timeOfDayFromOverrides(base: ModelCost, rawOverrides: unknown): { peak: { input: number; output: number; cacheRead?: number }; schedule: PriceTimeOfDay } | undefined {
	if (!Array.isArray(rawOverrides)) { return undefined; }
	let factor: number | undefined;
	let days: number[] | undefined;
	let peak: { input: number; output: number; cacheRead?: number } | undefined;
	const windows: { from: number; to: number }[] = [];
	for (const raw of rawOverrides) {
		if (!raw || typeof raw !== 'object') { continue; }
		const entry = raw as Record<string, unknown>;
		if (entry.utc_start === undefined && entry.utc_end === undefined) { continue; }
		const input = perMillionFromPerToken(entry.prompt);
		const output = perMillionFromPerToken(entry.completion);
		if (input === undefined || output === undefined || base.input <= 0 || base.output <= 0) { return undefined; }
		const inputFactor = roundFactor(input / base.input);
		const outputFactor = roundFactor(output / base.output);
		if (inputFactor !== outputFactor) { return undefined; }
		if (inputFactor === 1) { continue; }
		if (inputFactor < 1) { return undefined; }
		const cacheRead = perMillionFromPerToken(entry.input_cache_read);
		if (cacheRead !== undefined && base.cache_read !== undefined && base.cache_read > 0 && roundFactor(cacheRead / base.cache_read) !== inputFactor) { return undefined; }
		if (factor !== undefined && factor !== inputFactor) { return undefined; }
		const from = minutesOfUtcHhmm(entry.utc_start);
		const to = minutesOfUtcHhmm(entry.utc_end);
		if (from === undefined || to === undefined || from === to) { return undefined; }
		const entryDays = Array.isArray(entry.utc_days) ? entry.utc_days.map(d => typeof d === 'string' ? UTC_DAY_NUMBERS[d.toLowerCase()] : undefined) : [];
		if (entryDays.some(d => d === undefined)) { return undefined; }
		const dayList = (entryDays as number[]).slice().sort((a, b) => a - b);
		if (days !== undefined && days.join(',') !== dayList.join(',')) { return undefined; }
		factor = inputFactor;
		days = dayList;
		peak = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}) };
		windows.push({ from, to });
	}
	if (factor === undefined || !peak || windows.length === 0) { return undefined; }
	return { peak, schedule: { windows, days: days ?? [], offPeakDates: new Set<string>(), offPeakFactor: roundFactor(1 / factor) } };
}
