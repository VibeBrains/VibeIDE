/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRunRecord } from './agentRunLedger.js';

/**
 * Окупается ли каскад «дешёвая модель черновиком, сильная — если не вышло».
 *
 * WHY this is measured rather than assumed: an escalation is paid ON TOP of the draft, not instead
 * of it. With a tenfold price gap the arithmetic is forgiving — a third of attempts may escalate and
 * the cascade still wins — but at some share it flips, and nothing about the failure announces
 * itself. The bill goes up, the work still gets done, and the cause is invisible in every log we
 * keep: the draft and the escalation look like two ordinary runs.
 *
 * So the ledger marks which runs were drafts and which were escalations, and this module turns that
 * into the two numbers that decide whether to keep the cascade: the share of attempts that escalated
 * and what the whole thing cost against doing it with the strong model from the start.
 *
 * The comparison is an estimate and says so. The counterfactual — what the strong model would have
 * spent on a task it never saw — cannot be measured, only approximated from what it spent on the
 * tasks it did take over. An estimate that names the direction is worth more than a precise number
 * about the wrong question.
 */

/** Price per 1M tokens, as the capability registry reports it. */
export interface ModelRate {
	readonly input: number;
	readonly output: number;
}

export interface CascadeEconomics {
	/** Draft attempts — the denominator. */
	readonly attempts: number;
	/** Drafts that were escalated to the stronger model. */
	readonly escalations: number;
	/** Escalations as a share of attempts, 0…1. `undefined` when nothing was attempted. */
	readonly escalationShare?: number;
	readonly draftTokens: number;
	readonly escalationTokens: number;
	/** What the runs actually cost, when the models' prices are known. */
	readonly spentUsd?: number;
	/** Estimated cost of the same work done by the strong model alone. */
	readonly strongOnlyUsd?: number;
	/** `spentUsd` − `strongOnlyUsd`; negative means the cascade saved money. */
	readonly deltaUsd?: number;
	/**
	 * The share at which the cascade stops paying for itself, 0…1.
	 *
	 * Above it, the drafts thrown away cost more than the escalations save.
	 */
	readonly breakEvenShare?: number;
}

/** Tokens a run consumed, ignoring the ones it never paid for twice. */
export function billedTokens(run: AgentRunRecord): number {
	return Math.max(0, (run.tokensUsed ?? 0) - (run.cachedTokens ?? 0));
}

/**
 * Доля входа в расходе, когда измеренной доли нет.
 *
 * Обычный прогон агента — это подавляюще промпт: результаты инструментов, файлы и история кратно
 * превосходят то, что модель пишет в ответ. Это умолчание, а не истина: у модели с неотключаемым
 * рассуждением выход сильно больше, и там работает измеренная доля (`observedOutputShare`).
 */
const INPUT_WEIGHT = 0.85;


/**
 * Доля выхода в расходе прогона по его собственной истории, или `undefined`, если истории нет.
 *
 * Умолчание 0.15 описывает обычный прогон агента, где подавляющая часть счёта — промпт. У модели с
 * неотключаемым рассуждением это неверно: трейс биллится как выход, а выход у таких моделей дороже входа
 * в несколько раз. Заменять умолчание выдуманным множителем нельзя — поэтому берётся измеренная доля из
 * журнала прогонов той же модели, а при отсутствии истории честно возвращается `undefined`.
 */
export function observedOutputShare(
	runs: readonly AgentRunRecord[],
	provider: string | undefined,
	model: string | undefined,
): number | undefined {
	let prompt = 0;
	let completion = 0;
	for (const run of runs) {
		if (run.provider !== provider || run.model !== model) { continue; }
		if (run.promptTokens === undefined || run.completionTokens === undefined) { continue; }
		prompt += run.promptTokens;
		completion += run.completionTokens;
	}
	const total = prompt + completion;
	if (total <= 0) { return undefined; }
	return completion / total;
}

/**
 * A blended per-token price, in dollars per token.
 *
 * Одна ставка на прогон, потому что счёт токенов у прогона один; разбивка, когда провайдер её
 * сообщил, идёт в вес через `outputShare`.
 *
 * @param outputShare Измеренная доля выхода; без неё берётся умолчание обычного прогона
 */
export function blendedRate(rate: ModelRate | undefined, outputShare?: number): number | undefined {
	if (!rate) {
		return undefined;
	}
	const output = outputShare === undefined || !Number.isFinite(outputShare)
		? 1 - INPUT_WEIGHT
		: Math.min(1, Math.max(0, outputShare));
	return (rate.input * (1 - output) + rate.output * output) / 1_000_000;
}

/**
 * Fold cascade runs into the economics of the arrangement.
 *
 * `rateOf` looks a model's price up; it returns `undefined` for a model whose price we do not know,
 * and every money figure then stays `undefined` rather than being computed from zeros. A report
 * that says «$0.00 saved» when it means «no prices known» is worse than one that says nothing.
 */
export function cascadeEconomics(
	runs: readonly AgentRunRecord[],
	rateOf: (provider: string | undefined, model: string | undefined) => ModelRate | undefined,
): CascadeEconomics {
	const drafts = runs.filter(r => r.cascadeDraft);
	const escalations = runs.filter(r => r.escalatedFromRunId !== undefined);

	const draftTokens = drafts.reduce((sum, r) => sum + billedTokens(r), 0);
	const escalationTokens = escalations.reduce((sum, r) => sum + billedTokens(r), 0);

	let spent = 0;
	let strongOnly = 0;
	let pricesKnown = drafts.length > 0 || escalations.length > 0;

	for (const draft of drafts) {
		const draftRate = blendedRate(rateOf(draft.provider, draft.model));
		if (draftRate === undefined) {
			pricesKnown = false;
			continue;
		}
		spent += billedTokens(draft) * draftRate;
	}

	for (const escalation of escalations) {
		const strongRate = blendedRate(rateOf(escalation.provider, escalation.model));
		if (strongRate === undefined) {
			pricesKnown = false;
			continue;
		}
		spent += billedTokens(escalation) * strongRate;
	}

	// The counterfactual: every attempt done by the strong model from the start. Its per-token price
	// comes from the escalations, because those are the only runs where we saw the strong model work;
	// with no escalation at all there is nothing to price it with and the comparison is skipped.
	const strongRates = escalations
		.map(r => blendedRate(rateOf(r.provider, r.model)))
		.filter((r): r is number => r !== undefined);
	const strongRate = strongRates.length > 0 ? strongRates.reduce((a, b) => a + b, 0) / strongRates.length : undefined;
	// For a task that DID escalate, what the strong model would have spent is what it actually spent:
	// the escalation run. Adding the draft's tokens on top would charge the counterfactual for work it
	// never had to do, and would make the cascade look good by inflating its rival.
	const escalatedDraftIds = new Set(escalations.map(r => r.escalatedFromRunId));
	const acceptedDraftTokens = drafts
		.filter(r => !escalatedDraftIds.has(r.runId))
		.reduce((sum, r) => sum + billedTokens(r), 0);
	if (strongRate !== undefined) {
		strongOnly = (escalationTokens + acceptedDraftTokens) * strongRate;
	}

	const draftRates = drafts
		.map(r => blendedRate(rateOf(r.provider, r.model)))
		.filter((r): r is number => r !== undefined);
	const draftRate = draftRates.length > 0 ? draftRates.reduce((a, b) => a + b, 0) / draftRates.length : undefined;

	// Break-even: a draft costs `d` and is wasted when escalated, an escalation costs `s` on top.
	// Cascade beats strong-only while d + share·s < s, i.e. share < 1 − d/s.
	const breakEvenShare = draftRate !== undefined && strongRate !== undefined && strongRate > 0
		? Math.max(0, 1 - draftRate / strongRate)
		: undefined;

	const money = pricesKnown && strongRate !== undefined;
	return {
		attempts: drafts.length,
		escalations: escalations.length,
		escalationShare: drafts.length > 0 ? escalations.length / drafts.length : undefined,
		draftTokens,
		escalationTokens,
		spentUsd: money ? spent : undefined,
		strongOnlyUsd: money ? strongOnly : undefined,
		deltaUsd: money ? spent - strongOnly : undefined,
		breakEvenShare,
	};
}
