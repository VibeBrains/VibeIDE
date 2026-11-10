/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Чистая логика диалога на критическом заполнении контекста.
 *
 * Диалог предлагает сжать историю, продолжить или остановить агента
 * Решение «показывать ли» и флаг принудительного сжатия живут здесь,
 * чтобы их можно было проверить без браузера и сервисов
 */

/** Заготовка поля «что сохранить»: её видно в диалоге и правят перед сжатием */
export const DEFAULT_PRESERVE_NOTE = 'Сохранить: принятые решения и открытые вопросы. Выбросить: отладку и промежуточные попытки. Перед продолжением перечитать бриф задачи и сверить статус с критерием готовности';

/** Варианты диалога; совпадают с ContextLimitAction из гарда */
export type ContextLimitDialogChoice = 'compact' | 'continue' | 'cancel';

/** Ниже этого числа сообщений сводка не экономит: сворачивать нечего */
export const BUDGET_FILL_MIN_MESSAGES = 6;

export interface ContextLimitDialogShowInput {
	readonly enabled: boolean;
	readonly threadId: string;
	readonly percentUsed: number;
	readonly criticalThresholdPercent: number;
}

/**
 * Показывать диалог не чаще одного раза на тред
 *
 * Повтор на каждом запросе превратил бы предупреждение в поток модалок,
 * а смена треда (и reset() гарда) возвращает право показать его снова
 */
export class ContextLimitDialogGate {

	private _shownThreadId: string | undefined = undefined;

	shouldShow(input: ContextLimitDialogShowInput): boolean {
		return input.enabled
			&& input.percentUsed >= input.criticalThresholdPercent
			&& input.threadId !== this._shownThreadId;
	}

	markShown(threadId: string): void {
		this._shownThreadId = threadId;
	}

	reset(): void {
		this._shownThreadId = undefined;
	}
}

/**
 * Флаг «сжать на следующем запросе»
 *
 * Сжатие выполняет budget-fill при сборке промпта, поэтому диалог не может
 * сжать историю сам — он оставляет флаг, а сборка забирает его один раз
 */
export class ForceCompactFlag {

	private _requested = false;

	request(): void {
		this._requested = true;
	}

	get requested(): boolean {
		return this._requested;
	}

	/** Забрать запрос; после вызова флаг снят, чтобы сжатие не повторялось само */
	consume(): boolean {
		const requested = this._requested;
		this._requested = false;
		return requested;
	}

	reset(): void {
		this._requested = false;
	}
}

export interface BudgetFillInput {
	/** Принудительное сжатие считаем превышением бюджета, даже если оценка влезает */
	readonly forceCompact: boolean;
	readonly beforeTokens: number;
	readonly budget: number;
	readonly messageCount: number;
}

/** Единое условие сводки: обычное превышение бюджета или принудительный запрос */
export function shouldBudgetFill(input: BudgetFillInput): boolean {
	const overBudget = input.forceCompact || input.beforeTokens > input.budget;
	return overBudget && input.messageCount > BUDGET_FILL_MIN_MESSAGES;
}
