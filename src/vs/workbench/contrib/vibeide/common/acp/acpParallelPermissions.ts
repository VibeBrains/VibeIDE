/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Как открытые вопросы разрешения ложатся на вызовы в ленте
 *
 * Claude Code в одном ходу запускает несколько команд сразу: кадры `tool_call` со статусом `pending`
 * приходят все, а вопросы `session/request_permission` — по одному и по порядку. Без привязки карточка
 * вопроса вставала в конец ленты, под последней командой, и человек отвечал не про тот вызов.
 * Связь у протокола уже есть: `request.toolCallId` вопроса равен `toolCallId` вызова
 *
 * Слой чистый: ни React, ни IPC, ни сервисов — поэтому проверяется из `test/common/`
 */

/** Вопрос, у которого известен адрес вызова: остальное карточке даёт сервис сессии */
export interface IAcpQuestionOfCall {
	readonly request: { readonly toolCallId: string };
}

/** Привязанные вопросы — в порядке, в котором их задал агент; «бездомные» остаются в общем блоке */
export interface IAcpQuestionSplit<T> {
	readonly bound: readonly { readonly toolCallId: string; readonly question: T }[];
	readonly homeless: readonly T[];
}

/**
 * Разложить вопросы по вызовам ленты
 *
 * Вызов считается найденным, если его `toolCallId` есть в ленте: вопрос про вызов, которого лента
 * ещё не показала, привязывать не к чему, и потерять его нельзя — он ждёт ответа
 */
export function splitAcpQuestions<T extends IAcpQuestionOfCall>(questions: readonly T[], feedToolCallIds: readonly string[]): IAcpQuestionSplit<T> {
	const known = new Set(feedToolCallIds);
	const bound: { toolCallId: string; question: T }[] = [];
	const homeless: T[] = [];
	const taken = new Set<string>();
	for (const question of questions) {
		const toolCallId = question.request.toolCallId;
		// Пустой toolCallId — не адрес: такой вопрос не к чему привязать
		// Второй вопрос того же вызова ушёл бы в никуда: под карточкой виден только первый, поэтому он «бездомный»
		if (toolCallId && known.has(toolCallId) && !taken.has(toolCallId)) {
			taken.add(toolCallId);
			bound.push({ toolCallId, question });
		} else {
			homeless.push(question);
		}
	}
	return { bound, homeless };
}

/** Открытый вопрос именно этого вызова: второй вопрос того же вызова показали бы оба, а ответ один */
export function questionOfCall<T extends IAcpQuestionOfCall>(questions: readonly T[], toolCallId: string): T | undefined {
	return toolCallId ? questions.find(question => question.request.toolCallId === toolCallId) : undefined;
}

const ACP_TOOL_STATUS_NAMES: Record<string, string> = {
	pending: 'ждёт',
	in_progress: 'идёт',
	completed: 'готово',
	failed: 'ошибка',
	cancelled: 'отменено',
	unknown: 'идёт',
};

/**
 * Подпись стадии вызова
 *
 * `pending` у Claude Code значит «кадр пришёл, работа ещё не началась». У вызова с открытым вопросом
 * это «ждёт разрешения», у остальных — «в очереди»: одно слово «ждёт» на всех читалось так, будто
 * висят все команды, хотя вопрос задан про первую
 */
export function acpToolStatusLabel(status: string, waitingForPermission: boolean): string | undefined {
	if (status === 'pending') {
		return waitingForPermission ? 'ждёт разрешения' : 'в очереди';
	}
	return ACP_TOOL_STATUS_NAMES[status];
}
