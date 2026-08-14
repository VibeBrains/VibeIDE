/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { AcpStopReason } from './acpProtocol.js';

/**
 * Контракт хоста ACP: VibeIDE как клиент, внешний агент как процесс.
 *
 * Живёт в main-процессе — там же, где телеграм-поллер и мост Claude Code, и по той же причине:
 * процесс агента один на приложение, а не на окно.
 */

export const VIBE_ACP_CHANNEL = 'vibeide-channel-acp';

/** Как запускать агента. Приходит из реестра проекта, а не зашито в код. */
export interface IAcpAgentLaunch {
	/** Имя для человека: то, что видно в чате и в ошибках. */
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Переменные окружения поверх унаследованных. */
	readonly env?: Readonly<Record<string, string>>;
	/** Рабочая папка сессии. Абсолютный путь — требование протокола. */
	readonly cwd: string;
}

/** Запрос разрешения от агента, ждущий ответа человека. */
export interface IAcpPermissionRequest {
	readonly requestId: string;
	readonly sessionId: string;
	/** Название инструмента, как его назвал агент. */
	readonly title: string;
	/** Что именно он собирается сделать — готовая строка для показа. */
	readonly detail: string;
	/** Варианты, предложенные самим агентом: их идентификаторы уходят обратно в ответе. */
	readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[];
}

export type AcpEvent =
	/** Кусок ответа агента. */
	| { readonly kind: 'text'; readonly sessionId: string; readonly text: string }
	/** Агент просит разрешения. */
	| { readonly kind: 'permission'; readonly request: IAcpPermissionRequest }
	/** Агент записал файл — правка уже прошла через наши ворота. */
	| { readonly kind: 'wrote'; readonly sessionId: string; readonly path: string }
	/** Ход закончился. */
	| { readonly kind: 'done'; readonly sessionId: string; readonly stopReason: AcpStopReason }
	/** Связь с агентом оборвалась. */
	| { readonly kind: 'failed'; readonly sessionId?: string; readonly error: string };

export interface IAcpSession {
	readonly sessionId: string;
	readonly agentName: string;
}

export interface IVibeAcpMain {
	/** Запустить агента и открыть сессию. */
	startSession(launch: IAcpAgentLaunch): Promise<IAcpSession>;
	/** Отправить задачу. Ответ приходит событиями. */
	prompt(sessionId: string, text: string): Promise<AcpStopReason>;
	/** Ответить на запрос разрешения выбранным вариантом агента. */
	answerPermission(requestId: string, optionId: string | undefined): Promise<void>;
	/** Прервать ход. */
	cancel(sessionId: string): Promise<void>;
	/** Закрыть сессию и погасить процесс. */
	endSession(sessionId: string): Promise<void>;
	readonly onEvent: Event<AcpEvent>;
}
