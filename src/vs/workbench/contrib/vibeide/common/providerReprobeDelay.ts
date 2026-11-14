/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Первый повтор опроса недоступного провайдера: локальный сервер, запущенный после IDE, появляется почти сразу */
export const FIRST_REPROBE_MS = 10_000;

/**
 * Потолок паузы между повторами
 * Сервера может не быть вовсе (провайдер из набора с адресом по умолчанию), и опрос каждые десять секунд
 * без конца засоряет журнал и сеть; раз в пять минут сервер, поднятый позже, всё равно подхватится
 */
export const MAX_REPROBE_MS = 5 * 60_000;

/** Пауза перед повтором номер `attempt` (с нуля): удваивается от первой до потолка */
export function reprobeDelayMs(attempt: number): number {
	return Math.min(FIRST_REPROBE_MS * 2 ** Math.max(0, attempt), MAX_REPROBE_MS);
}
