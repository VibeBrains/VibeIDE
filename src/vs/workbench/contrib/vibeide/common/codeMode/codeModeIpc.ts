/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Протокол Code Mode: окно ↔ главный процесс ↔ процесс-песочница
 *
 * Скрипт исполняется вне окна, но каждый `tools.<имя>(args)` обязан вернуться в окно:
 * только там живут одобрения, запреты путей и аудит. Поэтому вызов — это событие туда
 * и результат обратно, а не прямой доступ к инструментам из песочницы
 */

import { ICodeModeCallRecord } from './codeMode.js';

export const VIBE_CODE_MODE_CHANNEL = 'vibeide-channel-codeMode';

/** Окно → главный процесс: запустить скрипт */
export interface ICodeModeRunRequest {
	readonly executionId: string;
	readonly script: string;
	readonly timeoutMs: number;
	readonly maxCalls: number;
}

/** Песочница → окно: «выполни этот инструмент обычным путём» */
export interface ICodeModeCallRequest {
	readonly executionId: string;
	readonly callId: string;
	readonly tool: string;
	readonly argsJson: string;
}

/** Окно → песочница: чем закончился вложенный вызов */
export interface ICodeModeCallResult {
	readonly executionId: string;
	readonly callId: string;
	readonly ok: boolean;
	readonly text: string;
}

/** Чем закончился весь скрипт */
export interface ICodeModeOutcome {
	readonly logs: readonly string[];
	readonly calls: readonly ICodeModeCallRecord[];
	readonly valueText?: string;
	readonly valueError?: string;
	readonly error?: string;
}

export type CodeModeWorkerRequest =
	| { readonly t: 'run'; readonly executionId: string; readonly script: string; readonly timeoutMs: number; readonly maxCalls: number }
	| ICodeModeCallResult & { readonly t: 'toolResult' };

export type CodeModeWorkerResponse =
	| ICodeModeCallRequest & { readonly t: 'toolCall' }
	| { readonly t: 'done'; readonly executionId: string; readonly outcome: ICodeModeOutcome };

/** Текст отказа/ошибки должен быть коротким: он едет в чат и в аудит */
export const CODE_MODE_MAX_ERROR_CHARS = 2_000;

export function codeModeErrorMessage(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.length <= CODE_MODE_MAX_ERROR_CHARS ? text : `${text.slice(0, CODE_MODE_MAX_ERROR_CHARS)}…`;
}
