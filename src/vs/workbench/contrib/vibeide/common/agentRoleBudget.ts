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
