/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Продолжать ли ход, кончившийся текстом без вызова инструмента
 *
 * WHY: модель иногда пишет «сейчас сделаю» и останавливается. Подпин возвращает её к работе, но на
 * вопрос модели должен отвечать человек, а не второй прогон: иначе агент сам себе отвечает и уходит
 * не туда. Решение чистое — без таймеров, сервисов и знания о том, как именно отправляется подпин
 */

/** Исход решения: остановиться или подтолкнуть ход одним из способов */
export type TurnContinuation = 'stop' | 'questionNudge' | 'emptyTurnNudge' | 'textTurnNudge';

/** Всё, что нужно знать о закончившемся ходе, чтобы решить, продолжать ли его */
export interface ITurnContinuationInput {
	readonly askedQuestion: boolean;   // ход кончился вопросом
	readonly emptyTurn: boolean;       // текста нет
	readonly autonomousMode: boolean;  // isAutonomousPermissionMode
	readonly humanless: boolean;       // тред без человека: пайплайн, HTTP API, Telegram
	readonly textNudgesUsed: number;
	readonly maxTextNudges: number;     // 0 — подпинов нет
	readonly questionNudgesUsed: number;
	readonly maxQuestionNudges: number; // 0 — без лимита
}

/** Решить судьбу хода: вопрос всегда идёт человеку, а подпин текста — только автономному режиму */
export function decideTurnContinuation(input: ITurnContinuationInput): TurnContinuation {
	if (input.askedQuestion) {
		// Человека нет — вопрос некому показать, и ход завис бы навсегда без подпина
		const questionNudgeAllowed = input.maxQuestionNudges === 0 || input.questionNudgesUsed < input.maxQuestionNudges;
		return input.humanless && questionNudgeAllowed ? 'questionNudge' : 'stop';
	}
	// Управляемый режим останавливается на тексте: человек сам решит, продолжать ли
	if (!input.autonomousMode) {
		return 'stop';
	}
	if (input.maxTextNudges > 0 && input.textNudgesUsed < input.maxTextNudges) {
		return input.emptyTurn ? 'emptyTurnNudge' : 'textTurnNudge';
	}
	return 'stop';
}
