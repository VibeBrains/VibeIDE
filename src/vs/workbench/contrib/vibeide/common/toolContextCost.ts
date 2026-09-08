/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Контекстный налог: во сколько обходятся результаты инструментов, которые модель перечитывает.
 *
 * WHY: the expensive part of an agent turn is not «the tool returned a lot», it is that everything a
 * tool returned is re-sent with every later request of the same turn. A 40 000-token file read on
 * step 2 of a forty-step turn is billed thirty-eight more times, and nothing in the usual reporting
 * says so — the spend report shows the total, the tool log shows the call, and the connection
 * between them exists only in the bill.
 *
 * So we count the connection directly: for each tool, how much its results weigh, and how many
 * later round-trips carried that weight. `carried` is the re-billed part — the tax — and it is the
 * number that names the worst tool in a repository, which is the only actionable output here.
 *
 * Two kinds of state, deliberately separate, because they have different lifetimes and different
 * owners: TOTALS are per profile and outlive everything (they are the report), while LIVE WEIGHTS
 * belong to one conversation's current turn — two chat tabs working at once carry two different
 * context windows, and a single shared «live» map would let one thread's turn end zero out the
 * other's, or charge it for tokens it never sent.
 *
 * Estimated, not measured, and deliberately so: the provider bills a prompt as a whole and never
 * says which part of it came from which tool. An estimate that names the right offender is worth
 * more than an exact number nobody can attribute.
 */

/** Characters per token — the same ratio the prompt estimator uses; see `imageTokenCost`. */
const CHARS_PER_TOKEN = 4;

export interface ToolContextTally {
	readonly tool: string;
	/** How many times the tool was called. */
	readonly calls: number;
	/** Tokens its results added to the context, summed over calls. */
	readonly produced: number;
	/**
	 * Tokens re-sent because those results stayed in the context for later round-trips.
	 *
	 * This is the tax proper: `produced` is paid once by necessity, `carried` is paid again for
	 * every request that followed while the result was still in the window.
	 */
	readonly carried: number;
}

/** Running totals per tool — the persisted half, shared by every conversation. */
export type ToolCostTotals = ReadonlyMap<string, ToolContextTally>;

/** Tokens each tool currently has sitting in ONE conversation's context window. */
export type TurnLiveWeights = ReadonlyMap<string, number>;

export const EMPTY_TOOL_COST_TOTALS: ToolCostTotals = new Map();
export const EMPTY_LIVE_WEIGHTS: TurnLiveWeights = new Map();

/** Tokens a tool result is worth, by the same ratio the prompt estimator uses. */
export function resultTokens(resultChars: number): number {
	return Math.ceil(Math.max(0, resultChars) / CHARS_PER_TOKEN);
}

/**
 * Record what a tool put into one conversation's context.
 *
 * Counted at the moment the result is produced, not when it is sent: a result the turn ended on
 * still cost its own tokens once, and dropping it would flatter the tool that ran last.
 */
export function recordToolResult(
	totals: ToolCostTotals,
	live: TurnLiveWeights,
	tool: string,
	resultChars: number,
): { totals: ToolCostTotals; live: TurnLiveWeights } {
	const added = resultTokens(resultChars);
	if (added === 0) {
		return { totals, live };
	}
	const previous = totals.get(tool);
	const nextTotals = new Map(totals);
	nextTotals.set(tool, {
		tool,
		calls: (previous?.calls ?? 0) + 1,
		produced: (previous?.produced ?? 0) + added,
		carried: previous?.carried ?? 0,
	});
	const nextLive = new Map(live);
	nextLive.set(tool, (nextLive.get(tool) ?? 0) + added);
	return { totals: nextTotals, live: nextLive };
}

/**
 * Charge one conversation's live results for one more round-trip.
 *
 * Called when a request goes out carrying the accumulated context. Everything a tool left in that
 * window is billed again, which is precisely the cost the caller cannot see anywhere else.
 */
export function chargeRoundTrip(totals: ToolCostTotals, live: TurnLiveWeights): ToolCostTotals {
	if (live.size === 0) {
		return totals;
	}
	const next = new Map(totals);
	for (const [tool, weight] of live) {
		const previous = next.get(tool);
		if (!previous || weight === 0) {
			continue;
		}
		next.set(tool, { ...previous, carried: previous.carried + weight });
	}
	return next;
}

/**
 * Tools ordered by what they cost overall, worst first.
 *
 * Ordered by the sum rather than by `carried` alone: a tool called once with a huge result early in
 * a long turn and a tool that returns a little on every step are both worth seeing, and the sum is
 * what the bill actually contains.
 */
export function worstOffenders(totals: ToolCostTotals, limit: number): ToolContextTally[] {
	return [...totals.values()]
		.filter(t => t.produced > 0)
		.sort((a, b) => (b.carried + b.produced) - (a.carried + a.produced) || a.tool.localeCompare(b.tool))
		.slice(0, limit);
}

/** Everything the tools cost, produced plus re-billed. */
export function totalContextCost(totals: ToolCostTotals): { produced: number; carried: number } {
	let produced = 0;
	let carried = 0;
	for (const tally of totals.values()) {
		produced += tally.produced;
		carried += tally.carried;
	}
	return { produced, carried };
}

/** Persisted form: a plain object, because a Map does not survive JSON. */
export function serializeToolCost(totals: ToolCostTotals): Record<string, { calls: number; produced: number; carried: number }> {
	const out: Record<string, { calls: number; produced: number; carried: number }> = {};
	for (const [tool, tally] of totals) {
		out[tool] = { calls: tally.calls, produced: tally.produced, carried: tally.carried };
	}
	return out;
}

/** Restore totals from storage. Live weights are never restored: a past turn carries nothing now. */
export function deserializeToolCost(raw: unknown): ToolCostTotals {
	const totals = new Map<string, ToolContextTally>();
	if (raw && typeof raw === 'object') {
		for (const [tool, value] of Object.entries(raw as Record<string, unknown>)) {
			const v = value as { calls?: unknown; produced?: unknown; carried?: unknown };
			if (typeof v?.calls === 'number' && typeof v?.produced === 'number' && typeof v?.carried === 'number') {
				totals.set(tool, { tool, calls: v.calls, produced: v.produced, carried: v.carried });
			}
		}
	}
	return totals;
}
