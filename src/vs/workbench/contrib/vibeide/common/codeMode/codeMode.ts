/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Code Mode — чистая логика: пределы, проверка имён, отчёт и решение об одобрении
 *
 * Модель пишет один скрипт вместо серии вызовов инструментов; скрипт зовёт `tools.<имя>(args)`,
 * а каждый такой вызов возвращается в окно и идёт ОБЫЧНЫМ путём инструмента
 * Здесь нет ни vm, ни процессов: побочные эффекты живут в `node/` и `electron-main/`,
 * а правила собраны здесь, чтобы их можно было проверить без запуска песочницы
 */

import { ToolApprovalType } from '../toolsServiceTypes.js';

/** Имя инструмента, который модель получает при включённой настройке */
export const CODE_MODE_TOOL_NAME = 'run_code_mode';
export const CODE_MODE_SETTING_ENABLED = 'vibeide.agent.codeMode';
export const CODE_MODE_SETTING_TIMEOUT_SEC = 'vibeide.agent.codeModeTimeoutSec';

/** Пределы. Время и число вызовов — именованные константы, чтобы не искать их по коду */
export const CODE_MODE_TIMEOUT_SEC_DEFAULT = 60;
export const CODE_MODE_TIMEOUT_SEC_MIN = 1;
export const CODE_MODE_TIMEOUT_SEC_MAX = 300;
export const CODE_MODE_MAX_CALLS = 50;
export const CODE_MODE_MAX_SCRIPT_CHARS = 100_000;
export const CODE_MODE_MAX_ARGS_CHARS = 100_000;
export const CODE_MODE_MAX_OUTPUT_CHARS = 12_000;
export const CODE_MODE_MAX_VALUE_CHARS = 4_000;
export const CODE_MODE_MAX_LOG_LINES = 200;
export const CODE_MODE_MAX_LOG_CHARS = 400;
export const CODE_MODE_MAX_CALL_NAME_CHARS = 80;

export interface ICodeModeLimits {
	readonly timeoutSec: number;
	readonly maxCalls: number;
}

/** Пределы из настройки: мусор в значении не должен ни отключать защиту, ни удлинять прогон до бесконечности */
export function codeModeLimits(rawTimeoutSec: unknown): ICodeModeLimits {
	const parsed = typeof rawTimeoutSec === 'number' ? rawTimeoutSec : Number(rawTimeoutSec);
	const timeoutSec = Number.isFinite(parsed)
		? Math.min(CODE_MODE_TIMEOUT_SEC_MAX, Math.max(CODE_MODE_TIMEOUT_SEC_MIN, Math.round(parsed)))
		: CODE_MODE_TIMEOUT_SEC_DEFAULT;
	return { timeoutSec, maxCalls: CODE_MODE_MAX_CALLS };
}

/** Имена инструментов — такие же, как у встроенных: строчная латиница, цифры, подчёркивание */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Имена, которых нет среди инструментов, но через которые можно дотянуться до прототипа */
const FORBIDDEN_TOOL_NAMES: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor', CODE_MODE_TOOL_NAME]);

/**
 * Почему это имя нельзя отдать в `tools`, или `undefined`, если можно
 *
 * Проверяется и форма, и список запрещённых: скрипт подставляет имена сам, поэтому
 * `constructor` и `__proto__` — это не «неизвестный инструмент», а попытка выйти за пределы объекта
 */
export function codeModeToolRefusal(name: unknown): string | undefined {
	// Сначала запрещённые имена: `__proto__` не проходит проверку формы, но это не «опечатка»,
	// а именно попытка дотянуться до прототипа — отказ должен говорить о причине
	if (typeof name === 'string' && FORBIDDEN_TOOL_NAMES.has(name)) {
		return name === CODE_MODE_TOOL_NAME
			? `«${CODE_MODE_TOOL_NAME}» из скрипта недоступен: вложенный Code Mode запрещён`
			: `«${name}» — это путь к прототипу, а не имя инструмента`;
	}
	if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
		return `«${String(name).slice(0, CODE_MODE_MAX_CALL_NAME_CHARS)}» — недопустимое имя инструмента: разрешены строчная латиница, цифры и подчёркивание`;
	}
	return undefined;
}

/** Что остаётся в отчёте от одного вложенного вызова */
export interface ICodeModeCallRecord {
	readonly tool: string;
	readonly ok: boolean;
	readonly error?: string;
}

/** Отказ по бюджету вызовов; `undefined`, пока бюджет есть */
export function codeModeCallBudgetError(usedCalls: number, maxCalls: number = CODE_MODE_MAX_CALLS): string | undefined {
	return usedCalls >= maxCalls ? `Исчерпан предел вложенных вызовов (${maxCalls})` : undefined;
}

/** Решение «спрашивать ли человека» — то же, что у обычного вызова и у роли-субагента */
export interface ICodeModeApprovalSettings {
	readonly chatAgentAutopilot?: boolean;
	readonly autoApprove: Partial<Record<ToolApprovalType, boolean>>;
}

/**
 * Нужно ли подтверждение для вложенного вызова
 *
 * Вложенность не повод ослабить правила: автоодобрение берётся из тех же настроек,
 * а без него вопрос задаётся человеку, как в обычном ходе агента
 */
export function codeModeNeedsApproval(approvalType: ToolApprovalType | undefined, settings: ICodeModeApprovalSettings): boolean {
	if (!approvalType) {
		return false;
	}
	return settings.chatAgentAutopilot !== true && settings.autoApprove[approvalType] !== true;
}

export interface ICodeModeReportInput {
	readonly logs: readonly string[];
	readonly valueText?: string;
	readonly valueError?: string;
	readonly calls: readonly ICodeModeCallRecord[];
	readonly error?: string;
}

/** Обрезка с хвостом-объяснением: модель должна видеть, что вывод не поместился, а не думать, что он кончился */
export function truncateCodeModeOutput(text: string, maxChars: number = CODE_MODE_MAX_OUTPUT_CHARS): string {
	if (text.length <= maxChars) {
		return text;
	}
	const head = text.slice(0, maxChars);
	return `${head}\n… (обрезано ${text.length - maxChars} символов)`;
}

function clipLine(line: string): string {
	return line.length <= CODE_MODE_MAX_LOG_CHARS ? line : `${line.slice(0, CODE_MODE_MAX_LOG_CHARS)}…`;
}

/**
 * Ответ инструмента: вывод `console.log`, значение скрипта, ошибка и список вложенных вызовов
 *
 * Пустые разделы не печатаются: «вывода не было» и «вывод пустой строкой» — разные вещи,
 * и заголовок без содержимого только отнимает контекст
 */
export function buildCodeModeReport(input: ICodeModeReportInput): string {
	const parts: string[] = [];
	if (input.error) {
		parts.push(`Ошибка: ${input.error}`);
	}
	// Строки не режем по одной: иначе одна длинная строка молча превращается в огрызок,
	// и общая обрезка с честной пометкой «обрезано» до модели уже не доходит
	const logs = input.logs.slice(0, CODE_MODE_MAX_LOG_LINES);
	if (logs.length > 0) {
		const clippedCount = input.logs.length - logs.length;
		parts.push(`Вывод console.log (${input.logs.length}):\n${logs.join('\n')}${clippedCount > 0 ? `\n… ещё ${clippedCount} строк` : ''}`);
	}
	if (input.valueText !== undefined) {
		parts.push(`Значение скрипта (JSON):\n${truncateCodeModeOutput(input.valueText, CODE_MODE_MAX_VALUE_CHARS)}`);
	}
	if (input.valueError) {
		parts.push(`Значение скрипта не сериализуется: ${input.valueError}`);
	}
	if (input.calls.length > 0) {
		const lines = input.calls.map(call => call.ok ? `- ${call.tool}: успех` : `- ${call.tool}: ошибка${call.error ? ` — ${clipLine(call.error)}` : ''}`);
		parts.push(`Вложенные вызовы (${input.calls.length}):\n${lines.join('\n')}`);
	}
	return truncateCodeModeOutput(parts.join('\n\n'));
}
