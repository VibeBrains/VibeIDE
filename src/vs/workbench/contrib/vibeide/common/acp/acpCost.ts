/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Как расход гостя записывается для человека
 *
 * ACP присылает сумму вместе с единицей: код ISO 4217 для денег или свободная единица вроде credits
 * Знак доллара над суммой в евро или над кредитами утверждает то, чего агент не говорил
 * Поэтому единица едет вместе с числом и показывается как пришла
 *
 * Чистая: только форматирование, ни сервисов, ни состояния
 */

/** Коды ISO 4217 — три буквы; всё прочее — свободная единица вроде credits */
const ISO_CURRENCY = /^[A-Za-z]{3}$/;

/**
 * Сумма и её единица
 * Без единицы остаётся прежняя запись в долларах: агент, не приславший её, имел в виду доллары,
 * а голое число прочиталось бы как любое
 */
export function formatAcpCost(amount: number, currency?: string): string {
	const value = amount.toFixed(4);
	const unit = currency?.trim();
	if (!unit) { return `$${value}`; }
	if (unit.toUpperCase() === 'USD') { return `$${value}`; }
	return `${value} ${ISO_CURRENCY.test(unit) ? unit.toUpperCase() : unit}`;
}
