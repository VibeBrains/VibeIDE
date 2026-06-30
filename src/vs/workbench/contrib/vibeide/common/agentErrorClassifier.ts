/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Agent error classifier (294) — pure helper.
 *
 * Inventory of failure modes during an agent run:
 *   provider-4xx     → client-side request issue (model misconfig, etc.)
 *   provider-5xx     → provider outage; retry / failover candidate
 *   stream-broken    → got a partial chunk then nothing for the gap window
 *   timeout          → no chunks in the timeout window
 *   tool-failure     → MCP / built-in tool returned an error envelope
 *   ipc-error        → main↔renderer IPC channel disconnected
 *   cancelled        → user pressed Esc / clicked stop
 *   unknown          → fallback (we still want to surface SOMETHING)
 *
 * Each class maps to a toast descriptor (severity + actions). Pure —
 * caller passes the raw error / status code; this module never throws,
 * never reads window.fetch, never logs.
 *
 * vscode-free: no imports beyond standard lib.
 */

export type AgentErrorClass =
	| 'provider-quota'
	| 'provider-4xx'
	| 'provider-5xx'
	| 'stream-broken'
	| 'timeout'
	| 'tool-failure'
	| 'ipc-error'
	| 'cancelled'
	| 'unknown';

export type ToastSeverity = 'info' | 'warning' | 'error';

export type ToastAction = 'retry' | 'open-log' | 'copy-request-id' | 'switch-model' | 'dismiss';

export interface ToastDescriptor {
	severity: ToastSeverity;
	headline: string;
	body: string;
	actions: ReadonlyArray<ToastAction>;
	/** True when the chat itself already shows the error message. Used to
	 * suppress the toast when both would say the same thing. */
	duplicateOfChat: boolean;
}

export interface ClassifyInput {
	httpStatus?: number;
	errorMessage?: string;
	errorCode?: string;
	requestId?: string;
	source: 'provider' | 'tool' | 'ipc' | 'stream' | 'user' | 'unknown';
	/** True if the chat panel already rendered the same error inline. */
	alreadyInChat?: boolean;
}

/**
 * Classify a runtime error. Pure — never throws.
 */
export function classifyAgentError(input: ClassifyInput): AgentErrorClass {
	if (input.source === 'user') { return 'cancelled'; }
	if (input.source === 'ipc') { return 'ipc-error'; }
	if (input.source === 'tool') { return 'tool-failure'; }
	if (input.source === 'stream') { return 'stream-broken'; }

	const status = typeof input.httpStatus === 'number' ? input.httpStatus : undefined;
	if (status !== undefined) {
		// 402/429 — quota / rate limit, NOT a request misconfiguration: the previous
		// blanket 4xx wording («model / params misconfiguration») misdiagnosed an
		// exhausted monthly limit (observed openCodeGo Go 402).
		if (status === 402 || status === 429) { return 'provider-quota'; }
		if (status >= 400 && status < 500) { return 'provider-4xx'; }
		if (status >= 500 && status < 600) { return 'provider-5xx'; }
	}
	if (input.errorCode === 'ETIMEDOUT' || input.errorCode === 'ECONNABORTED') {
		return 'timeout';
	}
	if (input.errorCode === 'ECONNRESET' || input.errorCode === 'ENOTFOUND' || input.errorCode === 'EPIPE') {
		return 'stream-broken';
	}
	const msg = (input.errorMessage ?? '').toLowerCase();
	if (msg.includes('timed out') || msg.includes('timeout')) { return 'timeout'; }
	if (msg.includes('aborted by user')) { return 'cancelled'; }
	if (msg.includes('econnreset') || msg.includes('connection reset') || msg.includes('socket hang up')) { return 'stream-broken'; }

	return 'unknown';
}

/**
 * Map an error class + raw input into a toast descriptor. Pure.
 *
 * The actions list is ordered: caller can render the first as the
 * primary button, the rest in an overflow menu.
 */
export function buildToast(
	cls: AgentErrorClass,
	input: ClassifyInput,
): ToastDescriptor {
	const requestId = input.requestId ?? '';
	const requestIdSuffix = requestId.length > 0 ? ` (id: ${requestId})` : '';
	const dup = !!input.alreadyInChat;

	// Provider's own message is the truth — surface it (trimmed) instead of guessing.
	const providerMsg = (input.errorMessage ?? '').trim().slice(0, 200);

	switch (cls) {
		case 'provider-quota':
			return {
				severity: 'error',
				headline: 'Лимит провайдера исчерпан',
				body: `HTTP ${input.httpStatus}: ${providerMsg || 'квота или rate limit исчерпаны'}.${requestIdSuffix}`,
				actions: ['switch-model', 'open-log', 'dismiss'],
				duplicateOfChat: dup,
			};
		case 'provider-4xx':
			return {
				severity: 'error',
				headline: 'Провайдер отклонил запрос',
				body: `HTTP ${input.httpStatus}: ${providerMsg || 'возможна неверная конфигурация модели/параметров'}.${requestIdSuffix}`,
				actions: ['open-log', 'switch-model', 'dismiss'],
				duplicateOfChat: dup,
			};
		case 'provider-5xx':
			return {
				severity: 'error',
				headline: 'Сбой на стороне провайдера',
				body: `HTTP ${input.httpStatus} — повторите попытку или смените провайдера.${requestIdSuffix}`,
				actions: ['retry', 'switch-model', 'open-log'],
				duplicateOfChat: dup,
			};
		case 'stream-broken':
			return {
				severity: 'warning',
				headline: 'Стрим оборвался',
				body: `Получен частичный ответ, затем соединение разорвалось.${requestIdSuffix}`,
				actions: ['retry', 'open-log'],
				duplicateOfChat: dup,
			};
		case 'timeout':
			return {
				severity: 'warning',
				headline: 'Провайдер не отвечает (таймаут)',
				body: 'Нет ответа в отведённое окно ожидания.',
				actions: ['retry', 'switch-model', 'open-log'],
				duplicateOfChat: dup,
			};
		case 'tool-failure':
			return {
				severity: 'warning',
				headline: 'Инструмент вернул ошибку',
				body: input.errorMessage ?? 'Tool / MCP-сервер сообщил о сбое.',
				actions: ['retry', 'open-log'],
				duplicateOfChat: dup,
			};
		case 'ipc-error':
			return {
				severity: 'error',
				headline: 'Внутренний сбой IPC',
				body: 'Канал renderer ↔ main разорван. Перезагрузите окно.',
				actions: ['open-log'],
				duplicateOfChat: dup,
			};
		case 'cancelled':
			return {
				severity: 'info',
				headline: 'Запрос отменён',
				body: 'Прогон агента остановлен вами.',
				actions: ['dismiss'],
				duplicateOfChat: dup,
			};
		case 'unknown':
		default:
			return {
				severity: 'error',
				headline: 'Непредвиденная ошибка',
				body: input.errorMessage ?? 'Подробностей нет.',
				actions: ['open-log', 'copy-request-id'],
				duplicateOfChat: dup,
			};
	}
}

/**
 * Convenience: classify + build in one call. Caller uses this when it
 * doesn't need the intermediate class.
 */
export function classifyAndBuildToast(input: ClassifyInput): { cls: AgentErrorClass; toast: ToastDescriptor } {
	const cls = classifyAgentError(input);
	return { cls, toast: buildToast(cls, input) };
}
