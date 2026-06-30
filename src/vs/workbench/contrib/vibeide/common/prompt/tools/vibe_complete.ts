/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

// Explicit end-of-turn signal. A native tool call is an UNAMBIGUOUS completion intent —
// far more reliable than text heuristics that try (and fail) to enumerate every phrasing
// of "done". The agent loop short-circuits on this call and stops cleanly, so the model
// no longer gets re-nudged in a loop when it believes the task is finished.
export const VIBE_COMPLETE_TOOL: ToolDef<'vibe_complete'> = {
	name: 'vibe_complete',
	description: `Завершает текущий ход агента: вызови ТОЛЬКО когда задача полностью выполнена и больше нечего делать.
ПЕРЕД вызовом обязательно перепроверь, что всё действительно сделано:
- все запрошенные правки применены к файлам;
- сборка/тесты/линт проходят (если это требовалось);
- не осталось незакрытых шагов из задачи пользователя.
Если хоть что-то не доделано или ты не уверен — НЕ вызывай этот инструмент, а продолжи работу нужным инструментом.
Это единственный корректный способ завершить ход — не пиши «Готово» просто текстом, вызови этот инструмент.`,
	params: {
		summary: { description: 'Краткое резюме того, что было сделано (1–3 предложения). Заполнение этого поля помогает тебе ещё раз убедиться, что задача действительно закрыта.' },
	},
};
