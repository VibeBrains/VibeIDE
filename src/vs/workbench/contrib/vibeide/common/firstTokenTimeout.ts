/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Сколько сторожу ждать первого фрагмента ответа.
 *
 * Один и тот же порог до первого фрагмента и посреди потока рвал медленно
 * начинающие модели: на переписке в 400 сообщений первый токен приходил через 40 с,
 * сторож ждал 30 с, обрывал запрос, и каждый повтор модель начинала с нуля.
 * Порог до первого фрагмента зависит от размера запроса и от того, как быстро
 * эта модель стартовала раньше.
 *
 * Чистая функция: ни настроек, ни часов, ни состояния — их подаёт вызывающий.
 */

/** Минимальное ожидание первого фрагмента, если настройка не задана (мс) */
export const FIRST_TOKEN_FLOOR_MS = 30_000;
/** Потолок ожидания первого фрагмента, когда hard-stall выключен (мс) */
export const FIRST_TOKEN_CEILING_MS = 300_000;
/** Первые 50k токенов запроса ожидание не удлиняют — медленный старт даёт объём сверх них */
export const FIRST_TOKEN_BASE_PROMPT_TOKENS = 50_000;
/** Шаг объёма запроса, за который начисляется прибавка (токены) */
export const FIRST_TOKEN_PROMPT_STEP_TOKENS = 50_000;
/** Прибавка к ожиданию за каждые 50k токенов сверх базы (мс) */
export const FIRST_TOKEN_MS_PER_PROMPT_STEP = 10_000;
/** Во сколько раз ожидание превышает самую долгую наблюдённую задержку этой модели */
export const FIRST_TOKEN_HISTORY_FACTOR = 1.5;
/** Сколько последних задержек первого токена помнить на модель */
export const FIRST_TOKEN_HISTORY_SIZE = 10;

export interface FirstTokenTimeoutInput {
	/** Оценка размера запроса в токенах (символы / 4, как в остальном пайплайне) */
	promptTokensEstimate: number;
	/** Последние наблюдённые задержки первого токена этой модели (мс), новые в конце */
	observedFirstTokenMs: readonly number[];
	/** Нижняя граница из настройки `vibeide.chat.streamFirstTokenTimeoutSeconds` (мс) */
	floorMs: number;
	/** Верхняя граница: hard-stall, если он включён, иначе FIRST_TOKEN_CEILING_MS (мс) */
	ceilingMs: number;
}

/**
 * Порог ожидания первого фрагмента: floor + прибавка за объём, не меньше 1.5×
 * самой долгой задержки этой модели и не больше потолка.
 *
 * Потолок вызывающий обязан поднять до floor: настройка медленной модели не должна
 * молча урезаться порогом hard-stall, который сработал бы её раньше.
 */
export function firstTokenTimeoutMs(input: FirstTokenTimeoutInput): number {
	const floorMs = Math.max(0, input.floorMs);
	// Прибавка за объём: целые шаги сверх базы, запрос в 100k ждёт на 10 с дольше
	const extraTokens = Math.max(0, input.promptTokensEstimate - FIRST_TOKEN_BASE_PROMPT_TOKENS);
	const steps = Math.floor(extraTokens / FIRST_TOKEN_PROMPT_STEP_TOKENS);
	let timeoutMs = floorMs + steps * FIRST_TOKEN_MS_PER_PROMPT_STEP;
	// Модель, которая в прошлый раз начинала 40 с, быстрее не станет: 1.5× даёт запас на разброс
	if (input.observedFirstTokenMs.length > 0) {
		const slowestMs = Math.max(...input.observedFirstTokenMs);
		timeoutMs = Math.max(timeoutMs, slowestMs * FIRST_TOKEN_HISTORY_FACTOR);
	}
	return Math.round(Math.min(timeoutMs, Math.max(0, input.ceilingMs)));
}
