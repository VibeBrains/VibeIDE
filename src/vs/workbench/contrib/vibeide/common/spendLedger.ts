/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Spend ledger — pure aggregation of what each key actually cost.
 *
 * Why a ledger and not the fingerprint ring buffer that was here before: fingerprints live in
 * memory, cap at 1000 entries and were never written by anyone, so the provider dashboard showed
 * an empty table with `$0.0000`. Money spent last week must survive a restart, so the ledger
 * keeps day-level aggregates (small enough to persist, detailed enough to answer "where did it go").
 *
 * Pure by design: the caller supplies the clock and the price, so a test can replay a month
 * without a network or a running IDE.
 */

import type { ModelCost } from './modelCapabilities.js';

/** One line of the ledger: a day × provider × model bucket. */
export type SpendEntry = {
	/** `YYYY-MM-DD`, local date — the user reasons in their own days, not in UTC. */
	day: string;
	providerId: string;
	modelId: string;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	/** Prompt-cache hits, already counted inside `inputTokens` — kept apart to show the saving. */
	cachedInputTokens: number;
	/**
	 * `undefined` when the price of the model is unknown — NOT zero. Zero means "free" and would
	 * quietly understate the bill; unknown must stay visible as unknown.
	 */
	costUsd: number | undefined;
};

export type SpendLedgerState = {
	version: 1;
	entries: SpendEntry[];
};

/** Tokens of one exchange, the way AI SDK 6 reports them for every provider. */
export type ExchangeTokens = {
	/** The whole prompt: fresh input, cache reads and cache writes together. */
	readonly input: number;
	readonly output: number;
	/** Prompt-cache reads, counted inside `input`. */
	readonly cacheRead?: number;
	/** Prompt-cache writes, counted inside `input`; vendors that charge for them bill above the input rate. */
	readonly cacheWrite?: number;
};

/** How many days of history the ledger keeps. Older days are dropped on write. */
export const SPEND_RETENTION_DAYS = 90;

/** Entry cap as a second guard: a runaway loop must not grow the stored blob without bound. */
export const SPEND_MAX_ENTRIES = 4000;

export function emptyLedger(): SpendLedgerState {
	return { version: 1, entries: [] };
}

/** `YYYY-MM-DD` in the user's timezone. */
export function dayKey(timestampMs: number): string {
	const d = new Date(timestampMs);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Cost of one exchange. Returns `undefined` when the catalogue has no price — a model whose
 * price we do not know must not be reported as free (that mistake already cost us once: a zero
 * price made the router treat paid models as free and prefer them).
 *
 * `price` is the catalogue's own type, not a copy of it: a camelCase copy here once received the
 * catalogue's snake_case object, found no `cacheRead` and billed every cached token at the full
 * input rate — tenfold for Claude. A missing cache rate still falls back to the input rate: that is
 * what an undeclared rate means, and it is no longer what a declared one silently becomes.
 *
 * A long-prompt surcharge (`long_context`) prices the WHOLE request higher once the prompt is longer
 * than the threshold — «for the full request», as vendors word it. The threshold is the whole prompt,
 * cache included: the cached part was sent too.
 */
export function costOf(price: ModelCost | undefined, tokens: ExchangeTokens, options: CostOptions = {}): number | undefined {
	if (!price || (price.input === 0 && price.output === 0)) { return undefined; }
	const cacheRead = Math.max(0, tokens.cacheRead ?? 0);
	const cacheWrite = Math.max(0, tokens.cacheWrite ?? 0);
	const fresh = Math.max(0, tokens.input - cacheRead - cacheWrite);
	const longContext = price.long_context;
	const tier = !options.aggregate && longContext && longContext.over_input_tokens > 0 && tokens.input > longContext.over_input_tokens
		? longContext
		: undefined;
	const inputFactor = tier?.input ?? 1;
	const cacheFactor = tier?.cache ?? 1;
	const outputFactor = tier?.output ?? 1;
	return (fresh / 1_000_000) * price.input * inputFactor
		+ (cacheRead / 1_000_000) * (price.cache_read ?? price.input) * cacheFactor
		+ (cacheWrite / 1_000_000) * (price.cache_write ?? price.input) * cacheFactor
		+ (tokens.output / 1_000_000) * price.output * outputFactor;
}

/** How a cost is asked for. */
export type CostOptions = {
	/**
	 * The tokens are a SUM over several requests — a role's run, a replayed run. The long-prompt
	 * surcharge is decided per request, and a sum cannot say which request was long, so a sum is
	 * priced at the base rates and stays the estimate its caller already labels it.
	 */
	readonly aggregate?: boolean;
};

export type SpendRecord = {
	timestampMs: number;
	providerId: string;
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens?: number;
	/** Prompt-cache writes inside `inputTokens`. Priced, not stored: the bucket keeps the cost. */
	cacheWriteTokens?: number;
	price?: ModelCost;
};

/**
 * Folds one exchange into the ledger and returns a NEW state — the caller decides when to persist.
 * Entries stay sorted newest-day-first so both the report and the trimming are cheap.
 */
export function recordSpend(state: SpendLedgerState, record: SpendRecord): SpendLedgerState {
	const day = dayKey(record.timestampMs);
	const cached = record.cachedInputTokens ?? 0;
	const cost = costOf(record.price, { input: record.inputTokens, output: record.outputTokens, cacheRead: cached, cacheWrite: record.cacheWriteTokens ?? 0 });

	const entries = state.entries.slice();
	const index = entries.findIndex(e => e.day === day && e.providerId === record.providerId && e.modelId === record.modelId);

	if (index === -1) {
		entries.push({
			day,
			providerId: record.providerId,
			modelId: record.modelId,
			requests: 1,
			inputTokens: record.inputTokens,
			outputTokens: record.outputTokens,
			cachedInputTokens: cached,
			costUsd: cost,
		});
	} else {
		const prev = entries[index];
		entries[index] = {
			...prev,
			requests: prev.requests + 1,
			inputTokens: prev.inputTokens + record.inputTokens,
			outputTokens: prev.outputTokens + record.outputTokens,
			cachedInputTokens: prev.cachedInputTokens + cached,
			// Unknown stays unknown only while nothing priced landed in the bucket; once a priced
			// exchange arrives the bucket reports what IS known rather than nothing at all.
			costUsd: prev.costUsd === undefined && cost === undefined
				? undefined
				: (prev.costUsd ?? 0) + (cost ?? 0),
		};
	}

	entries.sort((a, b) => b.day.localeCompare(a.day) || a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId));

	const cutoff = dayKey(record.timestampMs - SPEND_RETENTION_DAYS * 24 * 60 * 60 * 1000);
	const kept = entries.filter(e => e.day >= cutoff).slice(0, SPEND_MAX_ENTRIES);

	return { version: 1, entries: kept };
}

export type SpendTotals = {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
	costUsd: number;
	/** True when at least one bucket had no price — the total is a floor, not the full bill. */
	hasUnpriced: boolean;
};

const emptyTotals = (): SpendTotals =>
	({ requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, hasUnpriced: false });

const addInto = (into: SpendTotals, e: SpendEntry): SpendTotals => ({
	requests: into.requests + e.requests,
	inputTokens: into.inputTokens + e.inputTokens,
	outputTokens: into.outputTokens + e.outputTokens,
	cachedInputTokens: into.cachedInputTokens + e.cachedInputTokens,
	costUsd: into.costUsd + (e.costUsd ?? 0),
	hasUnpriced: into.hasUnpriced || e.costUsd === undefined,
});

/** Entries within the last `days` days, counting the day of `nowMs` as day 1. */
export function entriesInWindow(state: SpendLedgerState, nowMs: number, days: number): SpendEntry[] {
	const from = dayKey(nowMs - (days - 1) * 24 * 60 * 60 * 1000);
	return state.entries.filter(e => e.day >= from);
}

export function totalsOf(entries: SpendEntry[]): SpendTotals {
	return entries.reduce(addInto, emptyTotals());
}

/** Totals per provider, biggest spender first — the answer to "which key is eating the budget". */
export function byProvider(entries: SpendEntry[]): Array<{ providerId: string; totals: SpendTotals }> {
	const map = new Map<string, SpendTotals>();
	for (const e of entries) {
		map.set(e.providerId, addInto(map.get(e.providerId) ?? emptyTotals(), e));
	}
	return [...map.entries()]
		.map(([providerId, totals]) => ({ providerId, totals }))
		.sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.requests - a.totals.requests || a.providerId.localeCompare(b.providerId));
}

/** Totals per model within a window. */
export function byModel(entries: SpendEntry[]): Array<{ providerId: string; modelId: string; totals: SpendTotals }> {
	const map = new Map<string, { providerId: string; modelId: string; totals: SpendTotals }>();
	for (const e of entries) {
		const key = `${e.providerId} ${e.modelId}`;
		const prev = map.get(key) ?? { providerId: e.providerId, modelId: e.modelId, totals: emptyTotals() };
		map.set(key, { ...prev, totals: addInto(prev.totals, e) });
	}
	return [...map.values()]
		.sort((a, b) => b.totals.costUsd - a.totals.costUsd || b.totals.requests - a.totals.requests || a.modelId.localeCompare(b.modelId));
}

/**
 * Расход по КЛЮЧУ, а не по провайдеру.
 *
 * WHY this is not `byProvider` with a rename: one key routinely backs several provider entries —
 * the seeded MiniMax pair shares a single `apiKeyRef` across its OpenAI and Anthropic routes — so a
 * per-provider table splits one key's spend in two and understates both halves. The question this
 * answers is the one asked after a key leaks: how much did THIS key cost, wherever it was used.
 *
 * `keyRefOf` returns the key a provider draws on, or `undefined` when the provider has no key
 * configured. Providers without a key are dropped rather than lumped together: an "unknown" row
 * summing unrelated providers is worse than no row.
 */
export function byKey(
	entries: readonly SpendEntry[],
	keyRefOf: (providerId: string) => string | undefined,
): Array<{ keyRef: string; providerIds: string[]; totals: SpendTotals }> {
	const map = new Map<string, { keyRef: string; providerIds: Set<string>; totals: SpendTotals }>();
	for (const e of entries) {
		const keyRef = keyRefOf(e.providerId);
		if (!keyRef) { continue; }
		const prev = map.get(keyRef) ?? { keyRef, providerIds: new Set<string>(), totals: emptyTotals() };
		prev.providerIds.add(e.providerId);
		map.set(keyRef, { ...prev, totals: addInto(prev.totals, e) });
	}
	return [...map.values()]
		.map(row => ({ keyRef: row.keyRef, providerIds: [...row.providerIds].sort(), totals: row.totals }))
		.sort((a, b) => b.totals.costUsd - a.totals.costUsd || a.keyRef.localeCompare(b.keyRef));
}

/** How an anomaly is decided. Every number here is a setting, not a constant of nature. */
export type SpendAnomalyOptions = {
	/** Days of history the baseline is taken from, excluding today. */
	baselineDays: number;
	/** Today must exceed the baseline by this factor to count. */
	multiplier: number;
	/** ...and must also exceed this many dollars, so cheap days do not cry wolf. */
	floorUsd: number;
	/** Fewer priced days than this in the window → no verdict at all. */
	minBaselineDays: number;
};

export const DEFAULT_SPEND_ANOMALY_OPTIONS: SpendAnomalyOptions = {
	baselineDays: 14,
	// Threefold is the smallest jump that is not ordinary variation between a light and a heavy day.
	multiplier: 3,
	// Below a dollar a threefold jump is noise — three cheap requests instead of one.
	floorUsd: 1,
	// One quiet day is not a baseline: without this, the second day of use always looks anomalous.
	minBaselineDays: 3,
};

export type SpendAnomaly = {
	keyRef: string;
	providerIds: string[];
	todayUsd: number;
	/** Median of the baseline days — median, not mean, so one past spike does not raise the bar. */
	baselineUsd: number;
};

/**
 * Ключи, которые сегодня тратят непохоже на себя же.
 *
 * WHY at all: the provider's own report arrives late and by email. A stolen key is spent by someone
 * else on the same account, and the only local signal is that today does not look like the last two
 * weeks. This is that signal — deliberately a comparison against the key's OWN history rather than
 * a fixed budget, because "normal" differs by an order of magnitude between users.
 *
 * NOT a security verdict: a genuinely heavy day trips it too. It says "look", not "you were robbed".
 */
export function keySpendAnomalies(
	state: SpendLedgerState,
	keyRefOf: (providerId: string) => string | undefined,
	nowMs: number,
	options: SpendAnomalyOptions = DEFAULT_SPEND_ANOMALY_OPTIONS,
): SpendAnomaly[] {
	const today = dayKey(nowMs);
	const window = entriesInWindow(state, nowMs, options.baselineDays + 1);
	const perKeyDay = new Map<string, Map<string, number>>();
	const providersOf = new Map<string, Set<string>>();

	for (const e of window) {
		const keyRef = keyRefOf(e.providerId);
		// An unpriced bucket cannot be compared with a priced one — counting it as zero would make a
		// busy day look cheap and hide exactly the case this exists for.
		if (!keyRef || e.costUsd === undefined) { continue; }
		const days = perKeyDay.get(keyRef) ?? new Map<string, number>();
		days.set(e.day, (days.get(e.day) ?? 0) + e.costUsd);
		perKeyDay.set(keyRef, days);
		const seen = providersOf.get(keyRef) ?? new Set<string>();
		seen.add(e.providerId);
		providersOf.set(keyRef, seen);
	}

	const found: SpendAnomaly[] = [];
	for (const [keyRef, days] of perKeyDay) {
		const todayUsd = days.get(today) ?? 0;
		const baseline = [...days.entries()].filter(([day]) => day !== today).map(([, usd]) => usd).sort((a, b) => a - b);
		if (baseline.length < options.minBaselineDays) { continue; }
		const mid = Math.floor(baseline.length / 2);
		const baselineUsd = baseline.length % 2 === 1
			? baseline[mid]
			: (baseline[mid - 1] + baseline[mid]) / 2;
		if (todayUsd > options.floorUsd && todayUsd > baselineUsd * options.multiplier) {
			found.push({ keyRef, providerIds: [...(providersOf.get(keyRef) ?? [])].sort(), todayUsd, baselineUsd });
		}
	}
	return found.sort((a, b) => b.todayUsd - a.todayUsd || a.keyRef.localeCompare(b.keyRef));
}

/** Restores persisted state, tolerating anything that is not a ledger we recognise. */
export function parseLedger(raw: string | undefined): SpendLedgerState {
	if (!raw) { return emptyLedger(); }
	try {
		const parsed = JSON.parse(raw) as SpendLedgerState;
		if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) { return emptyLedger(); }
		// A corrupted entry must not poison the whole history — drop the entry, keep the rest.
		const entries = parsed.entries.filter(e =>
			e && typeof e.day === 'string' && typeof e.providerId === 'string' && typeof e.modelId === 'string'
			&& Number.isFinite(e.requests) && Number.isFinite(e.inputTokens) && Number.isFinite(e.outputTokens));
		return { version: 1, entries };
	} catch {
		return emptyLedger();
	}
}
