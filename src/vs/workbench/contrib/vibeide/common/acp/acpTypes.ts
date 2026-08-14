/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../base/common/event.js';
import { AcpStopReason, AcpToolStatus, IAcpAuthMethod, IAcpDiff } from './acpProtocol.js';

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
	/** Файлы, которых коснётся действие: по ним снимается чекпоинт ДО применения. */
	readonly paths: readonly string[];
	/** «Было → стало», как их показал сам агент. Пусто, если действие не про правку файла. */
	readonly diffs: readonly IAcpDiff[];
	/** Варианты, предложенные самим агентом: их идентификаторы уходят обратно в ответе. */
	readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[];
}

export type AcpEvent =
	/** Кусок ответа агента. */
	| { readonly kind: 'text'; readonly sessionId: string; readonly text: string; readonly thought: boolean }
	/** Агент просит разрешения. */
	| { readonly kind: 'permission'; readonly request: IAcpPermissionRequest }
	/** Агент взялся за инструмент: чем занят и что меняет. */
	| { readonly kind: 'tool'; readonly sessionId: string; readonly toolCallId: string; readonly title: string; readonly toolKind: string; readonly status: AcpToolStatus; readonly paths: readonly string[]; readonly diffs: readonly IAcpDiff[] }
	/** Расход контекста и денег за ход. */
	| { readonly kind: 'usage'; readonly sessionId: string; readonly used: number; readonly size: number; readonly costUsd?: number }
	/** Агент записал файл нашими руками — путь `fs/write_text_file`. */
	| { readonly kind: 'wrote'; readonly sessionId: string; readonly path: string }
	/** Агент не авторизован: ход не начнётся, пока человек не войдёт. */
	| { readonly kind: 'authRequired'; readonly sessionId: string; readonly agentName: string; readonly methods: readonly IAcpAuthMethod[] }
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
