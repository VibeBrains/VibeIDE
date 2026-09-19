/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Auto-scout trigger (Vibe Agents) — pure, side-effect-free classification of a chat request as a
 * "continuation" (продолжи / дальше / доделай …), plus the scout goal builder. A continuation
 * request is the high-signal case where the model reliably lacks context (it references prior work
 * that may have scrolled out of the thread), so a read-only `explore` scout is spawned to surface
 * the relevant leads before the main turn. Lives in `common` → unit-testable from `test/common/`.
 *
 * Trigger policy (agreed): auto on continuation (this module) + a manual one-shot override (input
 * toggle) — NOT a length/vagueness heuristic (too many false positives). See the pre-hook in
 * chatThreadService for the full decision (config gate + thin-context skip + loop guard).
 */

/**
 * Continuation markers. Cyrillic tokens are matched as bare substrings — JS `\b` is ASCII-only and
 * fails next to Cyrillic — so only ASCII tokens get `\b…\b`. Conservative on purpose: only phrases
 * that clearly mean "keep going on the previous work", to avoid scouting plain short requests.
 */
const RE_CONTINUATION = /(продолж|дальше|доделай|дострой|допиши|доведи\s+до\s+конца|заверши\s+начат|доработай|\bcontinue\b|\bgo on\b|keep going|carry on|\bfinish it\b|\bnext step\b)/i;

/**
 * Сколько слов сверх самой фразы продолжения ещё считается «голым продолжи».
 *
 * Разведка заводится ради случая, когда контекста нет ни у модели, ни в самом сообщении. Если
 * пользователь принёс контекст сам — текст ошибки, условие, что делать после, — разведывать нечего, а плата за
 * разведку — лишний прогон модели и задержка перед ответом.
 */
export const DEFAULT_MAX_WORDS_BEYOND_PHRASE = 5;

/** Слова — серии букв и цифр любого языка: знаки препинания и пути не должны раздувать счёт втрое. */
function countWords(text: string): number {
	return (text.trim().match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

/**
 * True when the request asks to continue prior work rather than describing a fresh, self-contained task.
 *
 * Порог приходит объектом, а не вторым числом: функцию зовут через `map`, а `map` передаёт вторым
 * аргументом индекс — числовой параметр молча получил бы его за порог. С объектом такой вызов не компилируется.
 *
 * Одной фразы мало: «продолжи действия, а после того как решишь — поищи причину падения» содержит
 * слово-триггер, но это задание целиком, а не отсылка к тому, что уехало из виду.
 */
export function isContinuationRequest(text: string, opts?: { readonly maxWordsBeyondPhrase?: number }): boolean {
	const match = RE_CONTINUATION.exec(text);
	if (!match) { return false; }
	// Отрицательный порог из конфига не должен выключать разведку совсем — для этого есть свой тумблер.
	return countWords(text) - countWords(match[0]) <= Math.max(0, opts?.maxWordsBeyondPhrase ?? DEFAULT_MAX_WORDS_BEYOND_PHRASE);
}

/**
 * True когда после ПРЕДЫДУЩЕГО сообщения пользователя в треде уже есть работа агента.
 *
 * Такая работа видна на экране и лежит в контексте хода — разведывать то, что только что сделано при человеке,
 * значит платить за пересказ собственного же хода. Разведка нужна там, где продолжать просят после паузы,
 * перезапуска или длинного чужого треда.
 *
 * @param roles Роли сообщений треда по порядку, включая только что добавленное сообщение пользователя
 */
export function hasAgentWorkSinceLastUserMessage(roles: readonly string[]): boolean {
	let i = roles.length - 1;
	// Текущее сообщение уже в треде — оно и есть повод для разведки, считать его за контекст нельзя.
	while (i >= 0 && roles[i] === 'user') { i--; }
	for (; i >= 0; i--) {
		if (roles[i] === 'user') { return false; }
		if (roles[i] === 'assistant' || roles[i] === 'tool') { return true; }
	}
	return false;
}

/**
 * Builds the read-only scout's goal. Structured so the explore agent returns actionable leads:
 * it is told the continuation phrasing, the recently-changed files, and the unfinished plan (both
 * optional), then asked for per-file leads + a one-line task hypothesis.
 */
export function buildScoutGoal(userRequest: string, changedPaths: readonly string[], planSummary?: string): string {
	const lines: string[] = [
		`Пользователь прислал continuation-запрос: "${userRequest.trim()}".`,
		'Определи (ТОЛЬКО ЧТЕНИЕ), что осталось недоделанным и что значит "продолжить" здесь.',
	];
	if (changedPaths.length) {
		lines.push(`Недавно изменённые файлы: ${changedPaths.join(', ')}.`);
	}
	if (planSummary && planSummary.trim()) {
		lines.push(`Незакрытый план:\n${planSummary.trim()}`);
	}
	if (!changedPaths.length && !planSummary?.trim()) {
		lines.push('Явного контекста правок/плана нет — разведай по кодовой базе и истории, что могло остаться недоделанным.');
	}
	lines.push('Верни: список зацепок (файл — что там недоделано) и краткую гипотезу задачи одним предложением.');
	return lines.join('\n');
}
