/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRunRecord, isTerminalRunStatus } from './agentRunLedger.js';
import { ModelRate, billedTokens, blendedRate } from './cascadeEconomics.js';

/**
 * Счёт за задачу — сколько стоило довести одну работу до конца, а не сколько стоил один запрос.
 *
 * WHY the per-run number is not enough: the spend ledger prices exchanges, and every exchange in it
 * looks reasonable. What empties a budget is a task that took four attempts, three of them thrown
 * away, and nothing in a per-run view says that the fourth run was the same work as the first. The
 * runs are cheap; the task is not, and the gap between those two numbers is exactly the money spent
 * on attempts nobody kept.
 *
 * Two deliberate choices:
 *
 *   - A task is a goal inside a thread. Runs group by `parentThreadId` plus the goal of the run that
 *     started the chain, and the chains the ledger already records — a replay (`replayOfRunId`), an
 *     escalation (`escalatedFromRunId`) — join their originals whatever their own goal text says.
 *     Nothing else identifies a task today; a task id would be a better key, and adding one is a
 *     ledger change rather than a report change.
 *   - «Finished» means the chain ended in a completed run, NOT that a human approved the result. The
 *     ledger carries no human verdict — the review checklist lives in the chat, not here — so every
 *     name below says «дошло до конца» and none of them implies an approval nobody recorded.
 *
 * Reported around the median and the ninth decile, never the mean: a handful of runaway tasks drag
 * an average far above anything that ever happened, and a number nothing resembles is not worth
 * reading.
 *
 * Pure: records and a price lookup in, numbers out.
 */

export interface TaskBill {
	readonly threadId: string;
	readonly goal: string;
	/** Runs belonging to this task, finished or not. */
	readonly attempts: number;
	/** Attempts that did not become the kept result: retries, failures, escalated drafts. */
	readonly discarded: number;
	/** The chain reached a `completed` run. False means abandoned, or still running. */
	readonly finished: boolean;
	readonly tokens: number;
	/** Tokens spent by the discarded attempts. */
	readonly wastedTokens: number;
	readonly usd?: number;
	readonly wastedUsd?: number;
	readonly startedAt: number;
	readonly endedAt?: number;
}

export interface TaskBillReport {
	/** Most expensive first: that is the order anyone opening this report is looking for. */
	readonly tasks: readonly TaskBill[];
	readonly finished: number;
	readonly abandoned: number;
	/** Median cost of a finished task; undefined when no finished task had a known price. */
	readonly medianUsd?: number;
	/** Ninth decile — what a bad day costs. Beside the median so the spread is visible. */
	readonly p90Usd?: number;
	/** Share of all known spend that went into discarded attempts, 0..1. */
	readonly wastedShare?: number;
	/** Tasks whose price could not be computed, surfaced instead of counted as free. */
	readonly unpricedTasks: number;
}

/** Quantile over a sorted array, linear interpolation. Empty input has no quantile. */
function quantile(sorted: readonly number[], q: number): number | undefined {
	if (sorted.length === 0) { return undefined; }
	if (sorted.length === 1) { return sorted[0]; }
	const pos = (sorted.length - 1) * q;
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function taskBills(
	runs: readonly AgentRunRecord[],
	rateOf: (provider: string | undefined, model: string | undefined) => ModelRate | undefined,
): TaskBillReport {
	// Follow replay and escalation links back to the run that started the chain, so an attempt whose
	// goal was reworded on the retry still bills against the task it belongs to. A link pointing at a
	// run already pruned away stops at the earliest record we still hold.
	const byId = new Map(runs.map(r => [r.runId, r]));
	const rootGoal = new Map<string, string>();
	const goalOfChain = (runId: string): string => {
		const cached = rootGoal.get(runId);
		if (cached !== undefined) { return cached; }
		const seen = new Set<string>();
		let current = runId;
		while (!seen.has(current)) { // a cycle can only come from a corrupt log: stop, do not hang
			seen.add(current);
			const record = byId.get(current);
			const parent = record?.replayOfRunId ?? record?.escalatedFromRunId;
			if (!parent || !byId.has(parent)) { break; }
			current = parent;
		}
		const goal = byId.get(current)?.goal ?? current;
		for (const id of seen) { rootGoal.set(id, goal); }
		return goal;
	};

	const groups = new Map<string, AgentRunRecord[]>();
	for (const run of runs) {
		// NUL joins the two parts: neither a thread id nor a goal can contain it, so no pair of
		// different tasks can collide into one key.
		const key = `${run.parentThreadId}\u0000${goalOfChain(run.runId)}`;
		const bucket = groups.get(key);
		if (bucket) { bucket.push(run); } else { groups.set(key, [run]); }
	}

	const tasks: TaskBill[] = [];
	let unpricedTasks = 0;
	let spendKnown = 0;
	let wastedKnown = 0;

	for (const bucket of groups.values()) {
		const ordered = [...bucket].sort((a, b) => a.startedAt - b.startedAt);
		// The kept result is the LAST completed run: a success followed by further attempts means
		// the success was not what the user kept.
		let keptIndex = -1;
		for (let i = ordered.length - 1; i >= 0; i--) {
			if (ordered[i].status === 'completed') { keptIndex = i; break; }
		}
		let tokens = 0;
		let wastedTokens = 0;
		let usd = 0;
		let wastedUsd = 0;
		let priced = true;
		for (let i = 0; i < ordered.length; i++) {
			const run = ordered[i];
			const billed = billedTokens(run);
			const discarded = i !== keptIndex;
			tokens += billed;
			if (discarded) { wastedTokens += billed; }
			const rate = blendedRate(rateOf(run.provider, run.model));
			if (rate === undefined) { priced = false; continue; }
			usd += billed * rate;
			if (discarded) { wastedUsd += billed * rate; }
		}
		const last = ordered[ordered.length - 1];
		const finished = keptIndex >= 0;
		if (priced) {
			spendKnown += usd;
			wastedKnown += wastedUsd;
		} else {
			unpricedTasks++;
		}
		tasks.push({
			threadId: ordered[0].parentThreadId,
			goal: goalOfChain(ordered[0].runId),
			attempts: ordered.length,
			discarded: ordered.length - (finished ? 1 : 0),
			finished,
			tokens,
			wastedTokens,
			usd: priced ? usd : undefined,
			wastedUsd: priced ? wastedUsd : undefined,
			startedAt: ordered[0].startedAt,
			endedAt: isTerminalRunStatus(last.status) ? last.endedAt : undefined,
		});
	}

	tasks.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || b.tokens - a.tokens);
	const finishedCosts = tasks
		.filter(t => t.finished && t.usd !== undefined)
		.map(t => t.usd as number)
		.sort((a, b) => a - b);

	return {
		tasks,
		finished: tasks.filter(t => t.finished).length,
		abandoned: tasks.filter(t => !t.finished).length,
		medianUsd: quantile(finishedCosts, 0.5),
		p90Usd: quantile(finishedCosts, 0.9),
		wastedShare: spendKnown > 0 ? wastedKnown / spendKnown : undefined,
		unpricedTasks,
	};
}
