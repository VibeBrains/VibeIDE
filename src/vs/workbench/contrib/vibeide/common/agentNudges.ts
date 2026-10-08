/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/**
 * Service messages the agent loop sends the model as a user turn (`isSyntheticNudge`)
 *
 * They are for the model, not for the person, and the chat shows each one folded: the headline in view, the text on click
 * Every text starts with «<emoji> <ЯРЛЫК>:», and that headline is all the folded line shows — `nudgeHeadlineOf` reads it
 * One module keeps the texts, so a new one is written next to the others and the format test sees it
 */

/** How long a headline may get before it is cut */
const NUDGE_HEADLINE_MAX_CHARS = 60;

/** The folded line of a service message: its label before the first colon, or its first line cut short */
export function nudgeHeadlineOf(text: string): string {
	const firstLine = text.trimStart().split('\n', 1)[0] ?? '';
	const colon = firstLine.indexOf(':');
	const label = (colon > 0 ? firstLine.slice(0, colon) : firstLine).trim();
	return label.length > NUDGE_HEADLINE_MAX_CHARS ? `${label.slice(0, NUDGE_HEADLINE_MAX_CHARS - 1)}…` : label;
}

/** The project's verify command failed after the agent changed files */
export function verifyGateNudge(command: string, exitCode: number | null | undefined, attempt: number, maxAttempts: number, output: string): string {
	return `⛔ VERIFY-GATE: команда «${command}» завершилась с ошибкой (exit ${exitCode ?? 'timeout'}). Задача НЕ считается выполненной — не вызывай vibe_complete, пока не станет зелёно. Исправь причину и продолжай работу инструментами (попытка ${attempt} из ${maxAttempts}).\n\nВывод команды:\n${output}`;
}

/**
 * The page broke the quality floor after the agent's edits
 * The UI-map reminder goes only to a project that has the map: advice to open a missing file teaches to skip the rest
 */
export function designHookNudge(findingLines: string, attempt: number, hasUiKit: boolean): string {
	const uiKitReminder = hasUiKit
		? '\n\nПеред тем как чинить: если правка требует элемента интерфейса, найдите его в карте UI (.vibe/design/uiKit.md) и используйте существующий, а не заводите новый.'
		: '';
	return `⛔ DESIGN-HOOK: страница после правок нарушает пол качества — это дефекты, а не вкус. Задача НЕ закрыта: исправь и продолжай инструментами (попытка ${attempt}).\n\n${findingLines}${uiKitReminder}\n\nЕсли что-то из перечисленного — намеренный выбор продукта, впиши правило в раздел «Детектор» файла .vibe/design/design.md с причиной, а не игнорируй молча.`;
}

/** The text written in this turn failed the slop check */
export function slopGateNudge(attempt: number, maxAttempts: number, details: string): string {
	return localize('vibeide.slopGate.corrective', "⛔ НЕЙРОСЛОП: текст, записанный в этом ходе, не прошёл проверку — попытка {0} из {1}. Перепиши найденное и продолжай инструментами.\n\n{2}\n\nНе добавляй фактов, чисел, имён и источников, которых нет в исходном тексте, и не меняй смысл. Порядок правки — в навыке anti-slop.", attempt, maxAttempts, details);
}

/** A tool tag in XML the parser could not extract */
export const XML_REPAIR_NUDGE = '⚙️ Авто-исправление: твой предыдущий tool-call был в некорректном/обрезанном XML и не распознан. Переотправь РОВНО ОДИН валидный tool-call в каноническом формате. Если инструмент не нужен — ответь обычным текстом.';

/** A tool call written as text in markup the IDE did not recognise */
export function unparsedToolCallNudge(): string {
	return localize('vibeide.agent.retryUnparsedToolCall', '⚙️ Вызов инструмента не выполнен: он пришёл текстом, в разметке, которую IDE не разобрала. Повтори этот же вызов через механизм вызова инструментов, в формате из системных инструкций, — не текстом ответа.');
}

/** Autopilot: the model ended its turn with a question nobody will answer */
export const AUTOPILOT_QUESTION_NUDGE = '⚙️ Авто-продолжение (автопилот): ты завершил ход вопросом, но автопилот включён — пользователь в этом режиме не отвечает. Прими решение самостоятельно (выбери разумный вариант по умолчанию, зафиксируй его одной строкой) и продолжай работу инструментами. Не жди подтверждения.';

/** Autopilot: the turn came back empty, most likely a delivery failure */
export const AUTOPILOT_EMPTY_TURN_NUDGE = '⚙️ Авто-продолжение (автопилот): твой предыдущий ход пришёл ПУСТЫМ (ни текста, ни вызова инструмента) — вероятно, сбой доставки ответа. Продолжай выполнение задачи с того места, где остановился: вызови следующий нужный инструмент или дай финальный ответ.';

/**
 * Autopilot: the turn ended in prose instead of a tool call
 *
 * The completion branch goes first and is the default reading: a weak caller takes the first imperative as the instruction
 * And loses the condition attached to it
 * The old wording opened with «НЕ закончена — продолжай» and closed with «прими разумное решение сам и продолжай»,
 * The freshest line in context, read as a licence to invent: MiniMax answered a finished task with fabricated files
 * See docs/knowledge/chatUx/chatInterruptAndInject.md
 */
export const AUTOPILOT_TEXT_TURN_NUDGE = '⚙️ Авто-продолжение (автопилот): ход не закрывается текстом — только вызовом инструмента.\n\n'
	+ 'Задача выполнена → вызови `vibe_complete`. Это единственный способ закончить. Перед вызовом перепроверь: правки применены, сборка и тесты проходят, шагов не осталось.\n\n'
	+ 'Задача НЕ выполнена → продолжай ровно её: вызови нужный инструмент.\n\n'
	+ 'ЗАПРЕЩЕНО: придумывать новую работу, о которой не просили; создавать файлы «на всякий случай»; выдумывать данные, которых нет в проекте. Если не знаешь, что делать дальше, — значит работа закончена: вызывай `vibe_complete`. Если для ПОСТАВЛЕННОЙ задачи не хватает данных — выбери разумный вариант из тех, что уже известны из проекта, назови его одной строкой и продолжай.';

/** Spelled-out completion tags for a model in XML tool mode: it cannot be forced via tool_choice */
export const AUTOPILOT_XML_COMPLETE_HINT = '\n\nТы в XML-режиме инструментов: чтобы ЗАВЕРШИТЬ ход, выведи РОВНО это и больше ничего —\n<vibe_complete>\n<summary>что сделано, 1–3 предложения</summary>\n</vibe_complete>';
