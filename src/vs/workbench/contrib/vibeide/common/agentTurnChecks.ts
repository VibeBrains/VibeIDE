/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * TURN-CHECKS — deterministic checks on what a turn actually did.
 *
 * VERIFY-GATE answers one question ("did the build stay green?") with one bit: an exit code. It
 * cannot see that a secret was written into a file, that a closed path was touched anyway, or
 * that the answer cites a line which does not exist. These are the questions a user asks about an
 * agent, and none of them needs a model to answer.
 *
 * Every check here is a pure function of facts the caller already collected. That is deliberate
 * and enforced by the type: `TurnCheckId` is a closed union, so an LLM-judged "check" cannot be
 * added without changing this contract on purpose. A judge that hallucinates a verdict is worse
 * than no check at all — it spends tokens to produce doubt.
 *
 * Shaped like the two gates that already exist (`verifyGatePolicy`, `designHookPolicy`): a mode,
 * an attempt counter and one decision function.
 */

export type TurnChecksMode =
	/** Never runs. */
	| 'off'
	/** Reports failures; the turn ends either way. */
	| 'notify'
	/** Sends the model back to fix them while attempts remain. */
	| 'enforce';

/**
 * The complete set of checks. Closed on purpose — see the module note: everything here must be
 * decidable from recorded facts alone.
 */
export type TurnCheckId =
	/** A secret-shaped value was written into a file the turn changed. */
	| 'no-secret-leak'
	/** A path closed by constraints or permissions was modified anyway. */
	| 'no-protected-path'
	/** A tool outside the allowed list was called. */
	| 'forbidden-action'
	/** The turn spent more than its token quota. */
	| 'budget-exceeded'
	/** The answer cites a file:line that does not exist. */
	| 'source-location';

export interface TurnFacts {
	/** Workspace-relative paths the turn wrote to. */
	readonly changedFiles: readonly string[];
	/** Secret matches found in those files: path plus the detector's label. */
	readonly secretHits: readonly { readonly file: string; readonly kind: string }[];
	/** Writes that landed on a closed path, with the pattern that closed it. */
	readonly protectedHits: readonly { readonly file: string; readonly pattern: string }[];
	/** Tools the turn called that were not in the allowed list. */
	readonly forbiddenTools: readonly string[];
	readonly tokensUsed: number;
	/** 0 means "no quota configured" — the budget check then cannot fail. */
	readonly tokenQuota: number;
	/** `path:line` references extracted from the answer, each already resolved by the caller. */
	readonly citations: readonly { readonly path: string; readonly line: number; readonly exists: boolean }[];
}

export interface TurnCheckResult {
	readonly id: TurnCheckId;
	readonly passed: boolean;
	/** Russian, ready to show — the corrective message is assembled from these. */
	readonly detail: string;
}

export type TurnChecksDecision = 'complete' | 'notify-complete' | 'bounce' | 'stop';

export interface TurnChecksInput {
	readonly mode: TurnChecksMode;
	readonly failures: readonly TurnCheckResult[];
	readonly attemptsUsed: number;
	readonly maxAttempts: number;
}

/** Checks enabled unless the project says otherwise: the two that protect the user's data. */
export const DEFAULT_ENABLED_CHECKS: readonly TurnCheckId[] = ['no-secret-leak', 'no-protected-path'];

/**
 * Run the enabled checks over the recorded facts. Pure; returns one result per enabled check so a
 * report can show passes as well as failures.
 */
export function evaluateTurnChecks(facts: TurnFacts, enabled: readonly TurnCheckId[]): TurnCheckResult[] {
	const results: TurnCheckResult[] = [];

	for (const id of enabled) {
		switch (id) {
			case 'no-secret-leak': {
				const hits = facts.secretHits;
				results.push({
					id,
					passed: hits.length === 0,
					detail: hits.length === 0
						? 'Секретов в изменённых файлах не найдено.'
						: `Похоже на секрет в изменённых файлах: ${hits.map(h => `${h.file} (${h.kind})`).join(', ')}.`,
				});
				break;
			}
			case 'no-protected-path': {
				const hits = facts.protectedHits;
				results.push({
					id,
					passed: hits.length === 0,
					detail: hits.length === 0
						? 'Закрытые пути не затронуты.'
						: `Записано в закрытые пути: ${hits.map(h => `${h.file} (правило ${h.pattern})`).join(', ')}.`,
				});
				break;
			}
			case 'forbidden-action': {
				const tools = facts.forbiddenTools;
				results.push({
					id,
					passed: tools.length === 0,
					detail: tools.length === 0
						? 'Инструменты вне списка не вызывались.'
						: `Вызваны инструменты вне разрешённого списка: ${tools.join(', ')}.`,
				});
				break;
			}
			case 'budget-exceeded': {
				const over = facts.tokenQuota > 0 && facts.tokensUsed > facts.tokenQuota;
				results.push({
					id,
					passed: !over,
					detail: over
						? `Расход ${facts.tokensUsed.toLocaleString('ru-RU')} токенов превысил квоту ${facts.tokenQuota.toLocaleString('ru-RU')}.`
						: 'Расход в пределах квоты.',
				});
				break;
			}
			case 'source-location': {
				const missing = facts.citations.filter(citation => !citation.exists);
				results.push({
					id,
					passed: missing.length === 0,
					detail: missing.length === 0
						? 'Все ссылки на код указывают на существующие строки.'
						: `Ссылки на несуществующие места: ${missing.map(m => `${m.path}:${m.line}`).join(', ')}.`,
				});
				break;
			}
		}
	}

	return results;
}

/**
 * Decide what the turn does with the failures.
 *
 * Mirrors the other gates: `notify` never blocks, `enforce` bounces the model until attempts run
 * out and then stops rather than looping on something it cannot fix.
 */
export function decideTurnChecks(input: TurnChecksInput): TurnChecksDecision {
	if (input.mode === 'off' || input.failures.length === 0) {
		return 'complete';
	}
	if (input.mode === 'notify') {
		return 'notify-complete';
	}
	return input.attemptsUsed < Math.max(1, input.maxAttempts) ? 'bounce' : 'stop';
}

/** The corrective text sent back to the model. Pure. */
export function renderTurnChecksCorrective(failures: readonly TurnCheckResult[], attempt: number, maxAttempts: number): string {
	const list = failures.map(f => `• ${f.detail}`).join('\n');
	return `⛔ ПРОВЕРКИ ХОДА: результат не прошёл детерминированные проверки. Задача НЕ закрыта — устрани причину и продолжай работу инструментами (попытка ${attempt} из ${maxAttempts}).\n\n${list}`;
}
