/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Council of models: one question, several independent answers, one summary.
 *
 * Why not just ask the same model twice: a model asked twice agrees with itself. The value here
 * comes from asking models that were trained differently, and from the fact that **advisers do
 * not see each other's answers** — otherwise the second one drifts toward the first and the panel
 * turns into an echo with extra cost.
 *
 * Pure module: prompts and folding only. Sending is the service's job, so both can be tested and
 * argued about separately.
 */

/** How a council member is addressed and what came back. */
export interface CouncilOpinion {
	readonly providerName: string;
	readonly modelName: string;
	/** Empty when the adviser failed — `error` then says why. */
	readonly text: string;
	readonly error?: string;
	readonly durationMs: number;
}

export interface CouncilRequest {
	readonly question: string;
	/** Extra material the advisers get verbatim (code, spec, constraints). */
	readonly context?: string;
}

/** Longest adviser answer kept when handing opinions to the summariser. */
export const COUNCIL_OPINION_LIMIT = 6000;

/**
 * Prompt for one adviser.
 *
 * Asks for a position and its cost in the same breath: an answer without "чем платим" reads as
 * free, and a panel of three free answers cannot be compared.
 */
export function councilAdviserPrompt(request: CouncilRequest): string {
	const parts = [
		'Ты — независимый советник. Тебе задают вопрос, по которому спрашивают ещё нескольких советников; их ответов ты не видишь и подстраиваться не под кого.',
		'',
		'Ответь по делу и коротко:',
		'1. Позиция — что делать, одним абзацем.',
		'2. Почему именно так — главные две-три причины.',
		'3. Чем платим — цена этого решения и когда оно плохо работает.',
		'4. При каком факте ты передумаешь.',
		'',
		'Не пересказывай вопрос, не извиняйся, не предлагай «оба варианта хороши»: от тебя ждут выбор.',
		'',
		`ВОПРОС:\n${request.question}`,
	];
	if (request.context?.trim()) {
		parts.push('', `КОНТЕКСТ:\n${request.context.trim()}`);
	}
	return parts.join('\n');
}

function trimOpinion(text: string): string {
	const flat = text.trim();
	return flat.length > COUNCIL_OPINION_LIMIT ? `${flat.slice(0, COUNCIL_OPINION_LIMIT)}\n… ответ обрезан` : flat;
}

/**
 * Prompt for the summariser.
 *
 * It is told to keep disagreement visible. A summary that smooths three positions into one bland
 * paragraph destroys exactly the information the council was paid for — the place where competent
 * answers diverge is the place worth a human decision.
 */
export function councilSummaryPrompt(request: CouncilRequest, opinions: readonly CouncilOpinion[]): string {
	const usable = opinions.filter(o => !o.error && o.text.trim());
	const blocks = usable.map((o, index) => `### Советник ${index + 1} — ${o.providerName}/${o.modelName}\n${trimOpinion(o.text)}`);
	return [
		'Ты сводишь мнения нескольких независимых советников по одному вопросу. Ты не выбираешь «самое приятное» и не сглаживаешь расхождения.',
		'',
		'Дай ровно это:',
		'1. **В чём согласны** — только то, что сказали все.',
		'2. **В чём расходятся** — по каждому расхождению: кто что предлагает и на каком основании.',
		'3. **Что решает исход** — какой факт нужно проверить, чтобы спор закрылся.',
		'4. **Рекомендация** — одна, с ценой. Если данных не хватает, так и скажи, вместо того чтобы выбрать наугад.',
		'',
		`ВОПРОС:\n${request.question}`,
		'',
		blocks.join('\n\n'),
	].join('\n');
}

export interface CouncilResult {
	readonly opinions: readonly CouncilOpinion[];
	/** `undefined` when there was nothing to summarise (no adviser answered). */
	readonly summary: string | undefined;
	readonly summaryError?: string;
}

/**
 * The council as text for the chat.
 *
 * Failed advisers are listed rather than hidden: a panel of five that silently became a panel of
 * two is a different answer, and the reader must be able to see that before trusting the summary.
 */
export function formatCouncilResult(request: CouncilRequest, result: CouncilResult): string {
	const answered = result.opinions.filter(o => !o.error && o.text.trim());
	const failed = result.opinions.filter(o => o.error || !o.text.trim());

	const lines: string[] = [`## Совет моделей: ${request.question.split('\n')[0]}`, ''];
	lines.push(`Ответили ${answered.length} из ${result.opinions.length}.`);

	if (result.summary) {
		lines.push('', result.summary.trim());
	} else if (result.summaryError) {
		lines.push('', `Свести мнения не удалось: ${result.summaryError}. Ниже — ответы советников как есть.`);
	}

	for (const opinion of answered) {
		lines.push('', `<details><summary>${opinion.providerName}/${opinion.modelName} — ${(opinion.durationMs / 1000).toFixed(1)} с</summary>`, '', trimOpinion(opinion.text), '', '</details>');
	}
	if (failed.length) {
		lines.push('', '**Не ответили:**', ...failed.map(o => `• ${o.providerName}/${o.modelName} — ${o.error ?? 'пустой ответ'}`));
	}
	return lines.join('\n');
}
