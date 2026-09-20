/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Какую задачу называет подсказка авто-продолжения.
 *
 * Подсказка автопилота говорила «продолжай ровно ту работу, которая была поставлена», не называя
 * её. Пока тред содержит одну задачу, это работает. Но стоит прежнему ходу оборваться — упёрся в
 * предохранитель, отменён, потерял ответ, — и в истории остаются две задачи: большая прежняя и
 * новая просьба пользователя. Модель читает «поставленную работу» как ту, которой в контексте
 * больше, то есть прежнюю, и принимается перепроверять её вместо нового запроса.
 *
 * Жалоба пользователя 20.09.2026 ровно об этом: «после снятия предохранителя новый запрос снова
 * запускает продолжение прежнего хода».
 *
 * Поэтому задача называется дословно. Берётся последнее НЕсинтетическое сообщение пользователя:
 * синтетические — это прошлые подсказки самого автопилота, и принять их за задачу значит замкнуть
 * круг.
 */

/** Сколько символов задачи попадает в подсказку: довольно, чтобы узнать, и мало, чтобы не раздуть. */
export const TASK_REMINDER_MAX_CHARS = 300;

/** Сообщение треда в той части, которая нужна для выбора задачи. */
export interface NudgeTaskCandidate {
	readonly role: string;
	readonly content?: string;
	readonly displayContent?: string;
	readonly isSyntheticNudge?: boolean;
}

/**
 * Задача, которую агент выполняет прямо сейчас, — дословно, как её написал человек.
 *
 * `undefined`, если человек в треде ещё ничего не просил: выдумывать задачу нельзя, а подсказка без
 * неё остаётся прежней.
 */
export function currentTaskOf(messages: readonly NudgeTaskCandidate[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== 'user' || message.isSyntheticNudge) { continue; }
		const text = (message.content ?? message.displayContent ?? '').trim();
		if (text) { return text; }
	}
	return undefined;
}

/** Строка-напоминание для подсказки, или пусто — когда называть нечего. */
export function taskReminderLine(task: string | undefined, maxChars: number = TASK_REMINDER_MAX_CHARS): string {
	if (!task) { return ''; }
	const flat = task.replace(/\s+/g, ' ').trim();
	if (!flat) { return ''; }
	const short = flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
	return `\n\nТЕКУЩАЯ ЗАДАЧА — ровно эта и никакая другая: «${short}»\nЧто обсуждалось в треде раньше, задачей не является: прежний ход мог оборваться, и его переспрашивать не нужно.`;
}
