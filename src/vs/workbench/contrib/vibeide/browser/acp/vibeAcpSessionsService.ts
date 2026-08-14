/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Сессии внешних агентов: состояние для поверхности и ворота, через которые проходит их работа.
 *
 * Почему это одно место, а не два. На запрос разрешения есть ровно один ответ, и если бы его
 * могли дать и вкладка, и уведомление, второй ответ уехал бы агенту в пустоту. Поэтому очередь
 * вопросов, чекпоинт и журнал живут здесь, а поверхность лишь показывает и нажимает.
 *
 * Чекпоинт снимается ДО показа вопроса: между «да» и правкой агента вставить его негде. Отказ
 * снимок отбрасывает — точки отката, которым не соответствует ни одной правки, засоряют историю.
 */

import { localize } from '../../../../../nls.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { AcpEvent, IAcpPermissionRequest, IAcpSession } from '../../common/acp/acpTypes.js';
import { AcpStopReason, IAcpDiff } from '../../common/acp/acpProtocol.js';
import { AcpSessionLog, IAcpSessionSnapshot } from '../../common/acp/acpSessionLog.js';
import { IVibeAcpService } from '../../common/acp/vibeAcpService.js';
import { IRollbackSnapshotService } from '../../common/rollbackSnapshotService.js';
import { IVibeAgentActivityLogService } from '../vibeAgentActivityLogService.js';
import { IVibeAcpRegistryService } from './vibeAcpRegistryService.js';
import { VibeAgentEntry } from '../../common/acp/vibeAgentsFile.js';

export const IVibeAcpSessionsService = createDecorator<IVibeAcpSessionsService>('vibeAcpSessionsService');

/** Что показывает поверхность про одну сессию. */
export interface IVibeAcpSessionView {
	readonly sessionId: string;
	readonly agentId: string;
	readonly agentName: string;
	/** Идёт ли ход прямо сейчас: пока идёт, задачу отправить нельзя, зато можно прервать. */
	readonly busy: boolean;
	/** Чем закончился прошлый ход. */
	readonly lastStopReason?: AcpStopReason;
	/** Ошибка последнего действия, если оно не удалось. */
	readonly error?: string;
	readonly log: IAcpSessionSnapshot;
	/** Вопрос, ждущий человека. Пока он есть, ход стоит. */
	readonly pendingPermission?: IAcpPermissionRequest;
}

export interface IVibeAcpSessionsService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** Живые сессии в порядке открытия. */
	readonly sessions: readonly IVibeAcpSessionView[];

	/** Открыта ли поверхность: от этого зависит, показывать ли вопрос уведомлением. */
	setSurfaceVisible(visible: boolean): void;

	startSession(agent: VibeAgentEntry): Promise<IAcpSession>;
	prompt(sessionId: string, text: string): Promise<void>;
	answerPermission(sessionId: string, optionId: string | undefined): Promise<void>;
	cancel(sessionId: string): Promise<void>;
	endSession(sessionId: string): Promise<void>;
}

interface ISessionState {
	readonly sessionId: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly log: AcpSessionLog;
	busy: boolean;
	lastStopReason?: AcpStopReason;
	error?: string;
	pending?: { readonly request: IAcpPermissionRequest; readonly snapshotId?: string };
}

class VibeAcpSessionsService extends Disposable implements IVibeAcpSessionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _sessions = new Map<string, ISessionState>();
	private _surfaceVisible = false;

	constructor(
		@IVibeAcpService private readonly _acpService: IVibeAcpService,
		@IVibeAcpRegistryService private readonly _registry: IVibeAcpRegistryService,
		@IRollbackSnapshotService private readonly _snapshotService: IRollbackSnapshotService,
		@IVibeAgentActivityLogService private readonly _activityLog: IVibeAgentActivityLogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._register(this._acpService.onEvent(event => this._observe(event)));
	}

	get sessions(): readonly IVibeAcpSessionView[] {
		return [...this._sessions.values()].map(state => ({
			sessionId: state.sessionId,
			agentId: state.agentId,
			agentName: state.agentName,
			busy: state.busy,
			lastStopReason: state.lastStopReason,
			error: state.error,
			log: state.log.snapshot,
			pendingPermission: state.pending?.request,
		}));
	}

	setSurfaceVisible(visible: boolean): void {
		this._surfaceVisible = visible;
	}

	async startSession(agent: VibeAgentEntry): Promise<IAcpSession> {
		const launch = this._registry.launchOf(agent);
		if (!launch) {
			throw new Error(localize('vibeide.acp.noWorkspace', "Открытой рабочей папки нет — агенту негде работать."));
		}
		const session = await this._acpService.startSession(launch);
		this._sessions.set(session.sessionId, {
			sessionId: session.sessionId,
			agentId: agent.id,
			agentName: session.agentName,
			log: new AcpSessionLog(),
			busy: false,
		});
		this._activityLog.logStarted(localize('vibeide.acp.log.session', "Внешний агент «{0}» открыл сессию", session.agentName));
		this._onDidChange.fire();
		return session;
	}

	async prompt(sessionId: string, text: string): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state || state.busy) { return; }
		state.busy = true;
		state.error = undefined;
		state.lastStopReason = undefined;
		this._onDidChange.fire();
		try {
			state.lastStopReason = await this._acpService.prompt(sessionId, text);
		} catch (err) {
			state.error = err instanceof Error ? err.message : String(err);
		} finally {
			state.busy = false;
			this._onDidChange.fire();
		}
	}

	/**
	 * Ответ человека. `undefined` — отказ.
	 *
	 * Отказ отбрасывает чекпоинт: правки, к которой он относился, не случилось.
	 */
	async answerPermission(sessionId: string, optionId: string | undefined): Promise<void> {
		const state = this._sessions.get(sessionId);
		const pending = state?.pending;
		if (!state || !pending) { return; }
		state.pending = undefined;
		this._onDidChange.fire();

		await this._acpService.answerPermission(pending.request.requestId, optionId);
		if (!optionId && pending.snapshotId) {
			await this._snapshotService.discardSnapshot(pending.snapshotId);
		}
	}

	cancel(sessionId: string): Promise<void> {
		return this._acpService.cancel(sessionId);
	}

	async endSession(sessionId: string): Promise<void> {
		await this._acpService.endSession(sessionId);
		this._sessions.delete(sessionId);
		this._onDidChange.fire();
	}

	// ── Приём событий ────────────────────────────────────────────────────────

	private _observe(event: AcpEvent): void {
		switch (event.kind) {
			case 'text':
				this._sessions.get(event.sessionId)?.log.appendText(event.text, event.thought);
				this._onDidChange.fire();
				return;
			case 'tool': {
				const state = this._sessions.get(event.sessionId);
				state?.log.applyTool(event.toolCallId, event.title, event.toolKind, event.status, event.paths, event.diffs);
				if (state) { this._journalEdit(state, event.toolCallId, event.status); }
				this._onDidChange.fire();
				return;
			}
			case 'usage':
				this._sessions.get(event.sessionId)?.log.applySpend(event.used, event.size, event.costUsd);
				this._onDidChange.fire();
				return;
			case 'permission':
				void this._guard(event.request);
				return;
			case 'wrote':
				this._activityLog.logFinished(localize('vibeide.acp.log.wrote', "Внешний агент записал файл нашими руками: {0}", event.path));
				return;
			case 'authRequired': {
				// Голый код ошибки не говорит, что делать. Способ входа агент назвал сам при знакомстве.
				const how = event.methods.map(method => method.description || method.name).join('; ');
				this._notificationService.error(how
					? localize('vibeide.acp.auth.withMethods', "Агент «{0}» не авторизован. Как войти: {1}", event.agentName, how)
					: localize('vibeide.acp.auth.bare', "Агент «{0}» не авторизован, и способов входа он не назвал.", event.agentName));
				return;
			}
			case 'failed': {
				const state = event.sessionId ? this._sessions.get(event.sessionId) : undefined;
				if (state) {
					state.busy = false;
					state.error = event.error;
					state.pending = undefined;
				}
				this._activityLog.logError(localize('vibeide.acp.log.failed', "Связь с внешним агентом оборвалась: {0}", event.error));
				this._onDidChange.fire();
				return;
			}
			case 'done': {
				const state = this._sessions.get(event.sessionId);
				if (state) { state.lastStopReason = event.stopReason; }
				this._onDidChange.fire();
				return;
			}
		}
	}

	/**
	 * Правка попадает в журнал по завершении вызова.
	 *
	 * Дифф берётся из ленты, где он уже накоплен, а НЕ из завершающего события: живой прогон
	 * показал, что дифф приезжает в кадре без статуса, а завершающий кадр несёт только текстовый
	 * итог. Слушатель, читающий дифф из завершающего события, не запишет ни одной правки.
	 */
	private _journalEdit(state: ISessionState, toolCallId: string, status: string): void {
		if (status !== 'completed' && status !== 'failed') { return; }
		const entry = state.log.snapshot.entries.find(item => item.kind === 'tool' && item.id === toolCallId);
		const diffs = entry?.kind === 'tool' ? entry.diffs : [];
		if (diffs.length === 0) { return; }
		const text = describeEdits(entry?.kind === 'tool' ? entry.title : '', diffs);
		if (status === 'failed') {
			this._activityLog.logError(localize('vibeide.acp.log.editFailed', "Правка внешнего агента не удалась: {0}", text));
		} else {
			this._activityLog.logFinished(text);
		}
	}

	/** Чекпоинт по путям правки, затем вопрос человеку — уведомлением, если вкладка закрыта. */
	private async _guard(request: IAcpPermissionRequest): Promise<void> {
		const state = this._sessions.get(request.sessionId);
		if (!state) {
			// Сессия не наша (например, осталась от прошлого окна): отвечаем отказом, иначе агент
			// будет ждать вечно.
			await this._acpService.answerPermission(request.requestId, undefined);
			return;
		}
		const snapshotId = await this._snapshotBefore(request);
		state.pending = { request, ...(snapshotId ? { snapshotId } : {}) };
		this._activityLog.logStarted(localize('vibeide.acp.log.asks', "Внешний агент просит разрешения: {0}", request.title));
		this._onDidChange.fire();

		if (!this._surfaceVisible) {
			this._notifyPending(request);
		}
	}

	private async _snapshotBefore(request: IAcpPermissionRequest): Promise<string | undefined> {
		if (request.paths.length === 0 || !this._snapshotService.isEnabled()) { return undefined; }
		try {
			const snapshot = await this._snapshotService.createSnapshot([...request.paths]);
			return snapshot.id;
		} catch (err) {
			// Не снятый чекпоинт — повод предупредить, а не повод не спросить: без вопроса
			// агент встанет навсегда.
			this._activityLog.logError(localize('vibeide.acp.log.noSnapshot', "Чекпоинт перед правкой внешнего агента не снят: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
	}

	/**
	 * Вопрос, когда вкладка закрыта.
	 *
	 * Кнопка ведёт на поверхность, а не отвечает за человека: в уведомление не помещается дифф,
	 * ради которого решение и принимается. Отвечать вслепую по имени файла — не решение.
	 */
	private _notifyPending(request: IAcpPermissionRequest): void {
		this._notificationService.prompt(
			Severity.Info,
			localize('vibeide.acp.permission.ask', "Внешний агент просит разрешения: {0}", request.title),
			[{
				label: localize('vibeide.acp.permission.show', "Показать"),
				run: () => void this._commandService.executeCommand(VIBE_ACP_SHOW_COMMAND_ID),
			}],
			{ sticky: true },
		);
	}
}

/** Команда открытия поверхности. Объявлена здесь, а исполнитель регистрируется вместе с панелью. */
export const VIBE_ACP_SHOW_COMMAND_ID = 'vibeide.externalAgents.show';

/** Строка журнала о правке: что за инструмент и сколько строк в каком файле изменилось. */
export function describeEdits(title: string, diffs: readonly IAcpDiff[]): string {
	const parts = diffs.map(diff => localize(
		'vibeide.acp.log.editEntry',
		"{0}: −{1}/+{2} строк",
		diff.path,
		countLines(diff.oldText),
		countLines(diff.newText)));
	return localize('vibeide.acp.log.edited', "Правка внешнего агента ({0}) — {1}", title || localize('vibeide.acp.log.unnamedTool', "инструмент без названия"), parts.join('; '));
}

/** Пустой текст — это ноль строк: так выглядит создание файла и удаление содержимого. */
const countLines = (text: string): number => (text ? text.split('\n').length : 0);

registerSingleton(IVibeAcpSessionsService, VibeAcpSessionsService, InstantiationType.Delayed);
