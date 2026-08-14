/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { ClaudeApprovalDecision } from './claudeCodeApproval.js';
import { IClaudeSdkStatus } from './claudeCodeProvision.js';

/**
 * Контракт моста «Claude Code с телефона».
 *
 * Живёт в main-процессе по той же причине, что и телеграм-поллер: экземпляр один на приложение.
 * Прогон переживает закрытие окна, а два окна не должны спорить, чей это прогон.
 */

/** Запрос разрешения, ушедший владельцу и ждущий ответа. */
export interface IClaudePendingApproval {
	readonly requestId: string;
	readonly runId: string;
	readonly toolName: string;
	/** Готовая карточка для телефона. */
	readonly card: string;
}

/** Что случилось в прогоне — для показа в чате. */
export type ClaudeRunEvent =
	/** Текст от ассистента (накопительный: сообщение редактируется, а не плодится). */
	| { readonly kind: 'text'; readonly runId: string; readonly text: string }
	/** Нужно разрешение. */
	| { readonly kind: 'approval'; readonly approval: IClaudePendingApproval }
	/** Прогон закончился. */
	| { readonly kind: 'done'; readonly runId: string; readonly sessionId?: string; readonly result?: string }
	/** Прогон упал. */
	| { readonly kind: 'failed'; readonly runId: string; readonly error: string };

export interface IClaudeRunRequest {
	/** Задача словами владельца. */
	readonly task: string;
	/** Рабочая папка. Задаётся явно — молча наследовать её опасно. */
	readonly cwd: string;
	/** Сессия для продолжения; пусто — начать новую. */
	readonly resumeSessionId?: string;
	/** Режим разрешений SDK. */
	readonly permissionMode?: 'default' | 'plan' | 'acceptEdits';
	/** Инструменты, разрешённые без вопроса. */
	readonly allowedTools?: readonly string[];
	/** Инструменты, запрещённые полностью. */
	readonly disallowedTools?: readonly string[];
	/** Показывать ли владельцу читающие инструменты. */
	readonly mirrorReadOnly?: boolean;
}

export interface IClaudeRunHandle {
	readonly runId: string;
	/** Сессия известна не сразу — её сообщает первый ответ SDK. */
	readonly sessionId?: string;
}

export const VIBE_CLAUDE_CODE_CHANNEL = 'vibeide-channel-claude-code';

export interface IVibeClaudeCodeMain {
	/** Состояние поставки SDK. */
	status(): Promise<IClaudeSdkStatus>;
	/** Поставить SDK. Долгая операция; повторный вызов во время установки безопасен. */
	install(): Promise<IClaudeSdkStatus>;
	/** Запустить задачу. Ответы приходят событиями. */
	start(request: IClaudeRunRequest): Promise<IClaudeRunHandle>;
	/** Ответить на запрос разрешения. */
	answerApproval(requestId: string, decision: ClaudeApprovalDecision, amendText?: string): Promise<void>;
	/** Прервать прогон. */
	stop(runId: string): Promise<void>;
	readonly onEvent: Event<ClaudeRunEvent>;
}
