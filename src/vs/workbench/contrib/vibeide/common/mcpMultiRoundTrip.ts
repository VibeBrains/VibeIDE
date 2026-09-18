/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Multi Round-Trip Requests (MRTR, SEP-2322) — как сервер теперь просит у клиента ввод.
 *
 * Ревизия 2026-07-28 объявила сломанной совместимость: сервер больше НЕ шлёт клиенту встречный
 * запрос (`elicitation/create`, `sampling/createMessage`, `roots/list`). Вместо этого он отвечает на
 * исходный вызов результатом `resultType: "input_required"`, а клиент повторяет ТОТ ЖЕ запрос,
 * приложив ответы и непрозрачный `requestState` дословно и с ДРУГИМ id.
 *
 * Два правила спеки, которые легко нарушить молча:
 *   - `requestState` не разбирается и не меняется — он для сервера, а не для нас;
 *   - результат без `resultType` считается завершённым (`complete`), иначе старые серверы
 *     перестали бы работать в тот же день.
 *
 * Зачем это здесь, пока серверов новой ревизии нет: конверт `input_required` — это НЕ результат
 * инструмента. Прежний разбор брал у него `content[0]`, не находил ничего и падал с сообщением,
 * по которому нельзя понять, что сервер вообще-то задал вопрос.
 */

/** Одна просьба сервера: чем именно клиент должен ответить. */
export interface McpInputRequest {
	/** Ключ, под которым ответ кладётся в `inputResponses`. */
	readonly key: string;
	/** Метод, который раньше приезжал встречным запросом: `elicitation/create` и подобные. */
	readonly method: string;
	/** Параметры просьбы, как их прислал сервер. */
	readonly params: unknown;
}

/** Конверт «мне нужен ввод», на который отвечают повтором запроса. */
export interface McpInputRequired {
	/** Непрозрачное состояние сервера: возвращается дословно и только ему. */
	readonly requestState: unknown;
	readonly inputRequests: readonly McpInputRequest[];
}

/**
 * Разобрать ответ сервера: это просьба о вводе или готовый результат.
 *
 * `undefined` — результат готов. Так же читается и ответ старого сервера, у которого поля
 * `resultType` нет вовсе: спека прямо требует считать его завершённым.
 */
export function parseInputRequired(result: unknown): McpInputRequired | undefined {
	if (!result || typeof result !== 'object') {
		return undefined;
	}
	const bag = result as Record<string, unknown>;
	if (bag.resultType !== 'input_required') {
		return undefined;
	}
	const requests = bag.inputRequests;
	if (!requests || typeof requests !== 'object') {
		return { requestState: bag.requestState, inputRequests: [] };
	}
	const inputRequests: McpInputRequest[] = [];
	for (const [key, raw] of Object.entries(requests as Record<string, unknown>)) {
		const entry = raw && typeof raw === 'object' ? raw as Record<string, unknown> : undefined;
		const method = typeof entry?.method === 'string' ? entry.method : '';
		if (!method) {
			continue;
		}
		inputRequests.push({ key, method, params: entry?.params });
	}
	return { requestState: bag.requestState, inputRequests };
}

/**
 * Параметры повторного вызова: те же самые плюс ответы и состояние сервера.
 *
 * Состояние копируется ссылкой намеренно — его нельзя ни разобрать, ни пересобрать, а попытка
 * «нормализовать» его была бы именно тем, что спека запрещает.
 */
export function withInputResponses(
	originalParams: Record<string, unknown>,
	inputResponses: Record<string, unknown>,
	requestState: unknown,
): Record<string, unknown> {
	return { ...originalParams, inputResponses, requestState };
}

/** Чем закончилась просьба, если отвечать на неё нечем: текст для модели, а не молчаливый сбой. */
export function describeUnansweredInput(toolName: string, input: McpInputRequired): string {
	const methods = input.inputRequests.map(request => request.method);
	const what = methods.length > 0 ? methods.join(', ') : 'без названного метода';
	return `Инструмент «${toolName}» не выполнен: сервер просит ввод (${what}), а VibeIDE пока не умеет отвечать на такие просьбы. Спросите нужное у пользователя сами и вызовите инструмент повторно с готовыми значениями.`;
}
