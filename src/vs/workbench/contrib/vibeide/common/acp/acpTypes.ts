/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AcpMcpServer } from './acpMcpExport.js';
import { Event } from '../../../../../base/common/event.js';
import { AcpCompactionStatus, AcpContentBlock, AcpNoticeSeverity, AcpReconnectMode, AcpStopReason, AcpToolStatus, IAcpAuthMethod, IAcpCommand, IAcpConfigOption, IAcpDiff, IAcpPromptCapabilities } from './acpProtocol.js';
import { AcpFileBefore } from './acpEditBaseline.js';

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
	/**
	 * MCP-серверы, которые гость получает при создании сессии (политика `mcpServers` записи агента).
	 *
	 * Список уже отфильтрован по политике и по выключателям пользователя. HTTP-записи из него
	 * отсеиваются ещё раз, в главном процессе, если гость не объявил поддержку такого транспорта в
	 * рукопожатии: узнать это раньше неоткуда.
	 */
	readonly mcpServers?: readonly AcpMcpServer[];
}

/** Запрос разрешения от агента, ждущий ответа человека. */
export interface IAcpPermissionRequest {
	readonly requestId: string;
	readonly sessionId: string;
	/** The guest's own id of the call — ties the answer to the call in the audit log. Empty if not sent. */
	readonly toolCallId: string;
	/** Название инструмента, как его назвал агент. */
	readonly title: string;
	/**
	 * Programmatic tool name (`read_file`), empty when the guest sends none. Shown next to the title
	 * because the title is free text the guest writes as it likes, while the name is stable. It is a
	 * label only: ACP declares it grants nothing, so no decision reads it.
	 */
	readonly name: string;
	/** ACP tool kind (`edit`, `execute`, `read`…), empty when not sent. */
	readonly toolKind: string;
	/** The command line of a shell call, when the agent sent it; empty for any other call. A title only describes it, this is what runs */
	readonly command: string;
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
	/** The question is no longer open: the agent withdrew it, or the turn was stopped and it was answered as cancelled */
	| { readonly kind: 'permissionWithdrawn'; readonly sessionId: string; readonly requestId: string }
	/** Агент взялся за инструмент: чем занят и что меняет. */
	| { readonly kind: 'tool'; readonly sessionId: string; readonly toolCallId: string; readonly title: string; readonly name: string; readonly toolKind: string; readonly status: AcpToolStatus; readonly paths: readonly string[]; readonly diffs: readonly IAcpDiff[]; readonly output: string; readonly exitCode?: number }
	/** Расход контекста и денег за ход. */
	| { readonly kind: 'usage'; readonly sessionId: string; readonly used: number; readonly size: number; readonly costUsd?: number; readonly origin?: string }
	/** Агент записал файл нашими руками — путь `fs/write_text_file`. */
	| { readonly kind: 'wrote'; readonly sessionId: string; readonly path: string }
	/**
	 * Файлы, какими их застали до правки: главный процесс читает их в момент, когда кадр вызова только пришёл
	 * Приходит раньше кадра, который о них рассказывает, и один раз на файл за ход
	 */
	| { readonly kind: 'before'; readonly sessionId: string; readonly files: readonly AcpFileBefore[] }
	/** Агент не авторизован: ход не начнётся, пока человек не войдёт. */
	| { readonly kind: 'authRequired'; readonly sessionId: string; readonly agentName: string; readonly methods: readonly IAcpAuthMethod[] }
	/** Ход закончился. */
	| { readonly kind: 'done'; readonly sessionId: string; readonly stopReason: AcpStopReason }
	/** The agent changed the session's settings itself (a model switch may change the modes on offer) */
	| { readonly kind: 'config'; readonly sessionId: string; readonly options: readonly IAcpConfigOption[] }
	/** The agent's own slash commands, the whole list; it may come again at any time */
	| { readonly kind: 'commands'; readonly sessionId: string; readonly commands: readonly IAcpCommand[] }
	/**
	 * Живое уведомление агента вне истории диалога (notice по ACP): остановка задачи, смена
	 * режима. Одно событие — одна строка в треде, дублирования и склейки не требуют
	 */
	| { readonly kind: 'notice'; readonly sessionId: string; readonly severity: AcpNoticeSeverity; readonly title: string; readonly description?: string }
	/**
	 * Кадр сущности «сжатие контекста» (compaction_update): открытие, patch или завершение
	 * Кадры одного compactionId журнал сходит на месте; `summary`/`error` присланы — заменить,
	 * отсутствуют — не трогать
	 */
	| { readonly kind: 'compaction'; readonly sessionId: string; readonly compactionId: string; readonly status: AcpCompactionStatus; readonly summary?: string; readonly error?: string }
	/** Кусок сводки сжатия (compaction_summary_chunk), дописывается к сущности */
	| { readonly kind: 'compactionChunk'; readonly sessionId: string; readonly compactionId: string; readonly text: string }
	/** Связь с агентом оборвалась. */
	| { readonly kind: 'failed'; readonly sessionId?: string; readonly error: string };

export interface IAcpSession {
	readonly sessionId: string;
	readonly agentName: string;
	/** The settings the agent exposes for this session; absent when it exposes none */
	readonly configOptions?: readonly IAcpConfigOption[];
	/** The agent's own slash commands, when it announced them before the session was handed over */
	readonly commands?: readonly IAcpCommand[];
	/** What the agent declared it accepts in a prompt: it decides whether a file goes as its text or as a link */
	readonly promptCapabilities: IAcpPromptCapabilities;
}

/** A session brought back after its agent process died, and how — which says what the agent remembers. */
export interface IAcpReconnection extends IAcpSession {
	readonly mode: AcpReconnectMode;
}

export interface IVibeAcpMain {
	/** Запустить агента и открыть сессию. */
	startSession(launch: IAcpAgentLaunch): Promise<IAcpSession>;
	/** Отправить задачу блоками содержимого. Ответ приходит событиями. */
	prompt(sessionId: string, blocks: readonly AcpContentBlock[]): Promise<AcpStopReason>;
	/** Ответить на запрос разрешения выбранным вариантом агента. */
	answerPermission(requestId: string, optionId: string | undefined): Promise<void>;
	/** Прервать ход. */
	cancel(sessionId: string): Promise<void>;
	/** Закрыть сессию и погасить процесс. */
	endSession(sessionId: string): Promise<void>;
	/** Change a setting the agent exposes; resolves to the full list after the change, which may move other options too */
	setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<readonly IAcpConfigOption[]>;
	/**
	 * Bring back a session whose agent process died: a new process, then the strongest way back the
	 * agent declared — `session/resume`, `session/load` or a new session. With `new` the id changes.
	 */
	reconnectSession(previousSessionId: string, launch: IAcpAgentLaunch): Promise<IAcpReconnection>;
	readonly onEvent: Event<AcpEvent>;
}
