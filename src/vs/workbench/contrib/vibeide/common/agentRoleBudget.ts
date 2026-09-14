/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Per-role token budget — a ceiling on what a role may spend over a rolling window.
 *
 * `vibeide.subagent.maxTokens` already caps ONE run. It says nothing about a role that runs
 * twenty times: twenty runs inside their per-run limit still add up to twenty times the cost.
 * This is the cumulative ceiling — the answer to "the reviewer must not burn more than X a day".
 *
 * Spend comes from the agent-run ledger, so the budget counts what actually happened rather than
 * an in-memory guess that dies with the window. Made possible by the ledger and by roles finally
 * reporting their spend; before that there was nothing honest to count.
 *
 * Pure: the caller supplies records and the clock.
 */

import { AgentRunRecord } from './agentRunLedger.js';
import { ModelRate, billedTokens, blendedRate } from './cascadeEconomics.js';

/** No budget configured for a role means "not limited" — never "limited to zero". */
export type RoleBudgets = Readonly<Record<string, number | null | undefined>>;

export interface RoleBudgetState {
	readonly role: string;
	/** Configured ceiling, or undefined when the role is unlimited. */
	readonly budget?: number;
	/** Tokens already spent by this role inside the window. */
	readonly spent: number;
	/** What is left; `undefined` when unlimited. */
	readonly remaining?: number;
	/** True when a new run must not start. */
	readonly exhausted: boolean;
}

/**
 * Tokens a role spent since `sinceMs`, counted from finished and running records alike — a run
 * still burning tokens is part of the bill, not a future problem.
 */
export function sumRoleSpend(records: readonly AgentRunRecord[], role: string, sinceMs: number): number {
	let total = 0;
	for (const record of records) {
		if (record.role === role && record.startedAt >= sinceMs) {
			total += record.tokensUsed ?? 0;
		}
	}
	return total;
}

/** Where a role stands against its ceiling. Pure. */
export function evaluateRoleBudget(
	records: readonly AgentRunRecord[],
	role: string,
	budgets: RoleBudgets,
	now: number,
	windowDays: number,
): RoleBudgetState {
	const raw = budgets[role];
	const budget = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
	const windowMs = Math.max(0, windowDays) * 24 * 60 * 60 * 1000;
	const spent = sumRoleSpend(records, role, windowMs > 0 ? now - windowMs : 0);

	if (budget === undefined) {
		return { role, spent, exhausted: false };
	}
	const remaining = Math.max(0, budget - spent);
	return { role, budget, spent, remaining, exhausted: spent >= budget };
}

/**
 * Why a run was refused, in the words the user will read. Kept next to the rule so the number in
 * the message can never drift from the number that made the decision.
 */
export function describeRoleBudgetRefusal(state: RoleBudgetState, roleName: string, windowDays: number): string {
	const period = windowDays === 1 ? 'сутки' : `${windowDays} дн.`;
	return `Роль «${roleName}» исчерпала свой бюджет: потрачено ${state.spent.toLocaleString('ru-RU')} из ${(state.budget ?? 0).toLocaleString('ru-RU')} токенов за ${period}. `
		+ 'Прогон не запущен. Поднимите бюджет роли в настройках («Роли агентов») или дождитесь, пока окно сдвинется.';
}

// -- Ceilings in money -------------------------------------------------------------------------

/**
 * A role's ceilings in dollars.
 *
 * WHY beside the token ceiling rather than instead of it: tokens are what a run consumes, dollars
 * are what the owner pays, and the exchange rate between them differs tenfold between models. A
 * token ceiling that is generous for a cheap model is ruinous for an expensive one, and the number
 * a person actually has an opinion about is the money. Both stay: one bounds the context a run may
 * chew through, the other bounds the bill.
 *
 * `perRun` is enforced by CONVERTING it into that run's token quota at launch, so the existing
 * quota machinery stops the run — no second stop mechanism, no second place to get it wrong.
 * `perDay` is checked against the ledger before launch, exactly like the token budget.
 */
export interface RoleUsdBudget {
	readonly perRun?: number;
	readonly perDay?: number;
}

export type RoleUsdBudgets = Readonly<Record<string, RoleUsdBudget | null | undefined>>;

/** Price lookup, same shape the cascade report and the task bill use. */
export type RateLookup = (provider: string | undefined, model: string | undefined) => ModelRate | undefined;

export interface RoleUsdBudgetState {
	readonly role: string;
	readonly perRun?: number;
	readonly perDay?: number;
	/**
	 * Dollars this role spent inside the window, or `undefined` when not a single run in it had a
	 * known price. Zero would be a lie in that case, and a lie in the direction of «spend freely».
	 */
	readonly spentUsd?: number;
	/** Runs inside the window whose price we do not know — they are NOT counted as free. */
	readonly unpricedRuns: number;
	/** True when the daily ceiling is reached and a new run must not start. */
	readonly exhausted: boolean;
}

/** What a role spent in dollars since `sinceMs`, and how much of its spend could not be priced. */
export function sumRoleSpendUsd(
	records: readonly AgentRunRecord[],
	role: string,
	sinceMs: number,
	rateOf: RateLookup,
): { readonly usd?: number; readonly unpricedRuns: number } {
	let usd = 0;
	let priced = 0;
	let unpricedRuns = 0;
	for (const record of records) {
		if (record.role !== role || record.startedAt < sinceMs) { continue; }
		const rate = blendedRate(rateOf(record.provider, record.model));
		if (rate === undefined) { unpricedRuns++; continue; }
		usd += billedTokens(record) * rate;
		priced++;
	}
	return { usd: priced > 0 ? usd : undefined, unpricedRuns };
}

/** Where a role stands against its money ceilings. Pure. */
export function evaluateRoleUsdBudget(
	records: readonly AgentRunRecord[],
	role: string,
	budgets: RoleUsdBudgets,
	now: number,
	windowDays: number,
	rateOf: RateLookup,
): RoleUsdBudgetState {
	const raw = budgets[role] ?? undefined;
	const positive = (v: number | undefined) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
	const perRun = positive(raw?.perRun);
	const perDay = positive(raw?.perDay);
	const windowMs = Math.max(0, windowDays) * 24 * 60 * 60 * 1000;
	const { usd, unpricedRuns } = sumRoleSpendUsd(records, role, windowMs > 0 ? now - windowMs : 0, rateOf);
	return {
		role,
		perRun,
		perDay,
		spentUsd: usd,
		unpricedRuns,
		exhausted: perDay !== undefined && usd !== undefined && usd >= perDay,
	};
}

/**
 * The token quota that spends exactly `usdPerRun` at this model's price, or `undefined` when the
 * price is unknown.
 *
 * An unknown price does NOT silently drop the ceiling to zero (that would refuse every run on an
 * unpriced model) and does not silently ignore it either — the caller reports which one happened.
 */
export function tokenQuotaForUsd(usdPerRun: number | undefined, rate: ModelRate | undefined): number | undefined {
	if (usdPerRun === undefined || usdPerRun <= 0) { return undefined; }
	const perToken = blendedRate(rate);
	if (perToken === undefined || perToken <= 0) { return undefined; }
	return Math.floor(usdPerRun / perToken);
}

const money = (v: number) => `$${v.toFixed(2)}`;

/** Why a run was refused by the daily money ceiling, in the words the user will read. */
export function describeRoleUsdRefusal(state: RoleUsdBudgetState, roleName: string, windowDays: number): string {
	const period = windowDays === 1 ? 'сутки' : `${windowDays} дн.`;
	const unpriced = state.unpricedRuns > 0
		? ` Ещё ${state.unpricedRuns} прогон(ов) в окне посчитать не удалось — цена их модели неизвестна, и в сумму они не вошли.`
		: '';
	return `Роль «${roleName}» исчерпала денежный потолок: потрачено ${money(state.spentUsd ?? 0)} из ${money(state.perDay ?? 0)} за ${period}.`
		+ ` Прогон не запущен. Поднимите потолок роли в настройках («Роли агентов») или дождитесь, пока окно сдвинется.${unpriced}`;
}
