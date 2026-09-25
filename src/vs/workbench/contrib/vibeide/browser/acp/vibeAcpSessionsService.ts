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
import { AcpReconnectMode, AcpStopReason, IAcpConfigOption, IAcpDiff } from '../../common/acp/acpProtocol.js';
import { AcpLogEntry, AcpSessionLog, IAcpSessionSnapshot } from '../../common/acp/acpSessionLog.js';
import { buildAcpPermissionAudit, buildAcpSessionAudit, buildAcpToolCallAudit } from '../../common/acp/acpAudit.js';
import { AuditEvent, IAuditLogService } from '../../common/auditLogService.js';
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
	/** The agent process died: the session cannot take a task until it is reconnected. */
	readonly disconnected: boolean;
	/** A reconnection is under way: a second click must not start a second agent. */
	readonly reconnecting: boolean;
	readonly log: IAcpSessionSnapshot;
	/** Вопрос, ждущий человека. Пока он есть, ход стоит. */
	readonly pendingPermission?: IAcpPermissionRequest;
	/** The settings the agent exposes — model, mode, thinking — as it last reported them */
	readonly configOptions: readonly IAcpConfigOption[];
	/** A setting change is on its way to the agent: the controls wait for its answer */
	readonly configuring: boolean;
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
	/** Change a setting the agent exposes; the card shows the state the agent answers with, not the value asked for */
	setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void>;
	/**
	 * Bring back a session whose agent process died, without restarting the IDE. The transcript stays;
	 * a note in it says whether the agent still remembers the conversation. With a new session the id
	 * changes — the card stays in its place under the new id.
	 */
	reconnect(sessionId: string): Promise<void>;
}

interface ISessionState {
	readonly sessionId: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly log: AcpSessionLog;
	busy: boolean;
	lastStopReason?: AcpStopReason;
	error?: string;
	disconnected: boolean;
	reconnecting: boolean;
	pending?: { readonly request: IAcpPermissionRequest; readonly snapshotId?: string };
	configOptions: readonly IAcpConfigOption[];
	configuring: boolean;
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
		@IAuditLogService private readonly _auditLog: IAuditLogService,
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
			disconnected: state.disconnected,
			reconnecting: state.reconnecting,
			log: state.log.snapshot,
			pendingPermission: state.pending?.request,
			configOptions: state.configOptions,
			configuring: state.configuring,
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
			disconnected: false,
			reconnecting: false,
			configOptions: session.configOptions ?? [],
			configuring: false,
		});
		this._activityLog.logStarted(localize('vibeide.acp.log.session', "Внешний агент «{0}» открыл сессию", session.agentName));
		this._audit(buildAcpSessionAudit({ agentId: agent.id, sessionId: session.sessionId, phase: 'started' }, Date.now()));
		this._onDidChange.fire();
		return session;
	}

	async prompt(sessionId: string, text: string): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state || state.busy) { return; }
		if (state.disconnected) {
			// The dead process cannot take the task; saying so beats a bare «session not found».
			state.error = localize('vibeide.acp.disconnected.prompt', "Связь с агентом оборвалась — переподключите его, чтобы отправить задачу.");
			this._onDidChange.fire();
			return;
		}
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
		const request = pending.request;
		this._audit(buildAcpPermissionAudit({
			agentId: state.agentId,
			sessionId,
			toolCallId: request.toolCallId,
			title: request.title,
			name: request.name,
			toolKind: request.toolKind,
			paths: request.paths,
			optionKind: optionId ? request.options.find(option => option.optionId === optionId)?.kind : undefined,
		}, Date.now()));
		if (!optionId && pending.snapshotId) {
			await this._snapshotService.discardSnapshot(pending.snapshotId);
		}
	}

	cancel(sessionId: string): Promise<void> {
		return this._acpService.cancel(sessionId);
	}

	async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state || state.configuring || state.disconnected) { return; }
		state.configuring = true;
		state.error = undefined;
		this._onDidChange.fire();
		try {
			state.configOptions = await this._acpService.setConfigOption(sessionId, configId, value);
		} catch (err) {
			// The control goes back to what the agent last reported: it still holds that value
			state.error = localize('vibeide.acp.config.failed', "Агент не принял настройку: {0}", err instanceof Error ? err.message : String(err));
		} finally {
			state.configuring = false;
			this._onDidChange.fire();
		}
	}

	async reconnect(sessionId: string): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state || !state.disconnected || state.reconnecting) { return; }
		// The launch is read again, not remembered: the entry in agents.json may have changed since.
		const agent = this._registry.agents.find(entry => entry.id === state.agentId);
		const launch = agent ? this._registry.launchOf(agent) : undefined;
		if (!agent || !launch) {
			state.error = agent
				? localize('vibeide.acp.noWorkspace', "Открытой рабочей папки нет — агенту негде работать.")
				: localize('vibeide.acp.reconnect.gone', "Агента «{0}» больше нет в .vibe/agents.json — переподключать некого.", state.agentName);
			this._onDidChange.fire();
			return;
		}
		state.reconnecting = true;
		state.error = undefined;
		this._onDidChange.fire();
		let current = state;
		try {
			const back = await this._acpService.reconnectSession(sessionId, launch);
			if (back.sessionId !== sessionId) {
				current = { ...state, sessionId: back.sessionId };
				this._rekey(sessionId, current);
			}
			current.disconnected = false;
			current.busy = false;
			// A new process may expose other settings; an agent that reported none keeps showing none
			current.configOptions = back.configOptions ?? [];
			current.log.appendNotice(reconnectNotice(back.mode));
			this._activityLog.logStarted(localize('vibeide.acp.log.reconnected', "Внешний агент «{0}» переподключён", current.agentName));
			this._audit(buildAcpSessionAudit({ agentId: current.agentId, sessionId: current.sessionId, phase: 'reconnected', reconnectMode: back.mode }, Date.now()));
		} catch (err) {
			current.error = localize('vibeide.acp.reconnect.failed', "Переподключить не удалось: {0}", err instanceof Error ? err.message : String(err));
		} finally {
			current.reconnecting = false;
			this._onDidChange.fire();
		}
	}

	/** A new id for the same card: the cards keep the order in which the sessions were opened. */
	private _rekey(previousId: string, next: ISessionState): void {
		const entries = [...this._sessions].map(([id, state]) => id === previousId ? [next.sessionId, next] as const : [id, state] as const);
		this._sessions.clear();
		for (const [id, state] of entries) {
			this._sessions.set(id, state);
		}
	}

	async endSession(sessionId: string): Promise<void> {
		await this._acpService.endSession(sessionId);
		const state = this._sessions.get(sessionId);
		if (state) {
			this._audit(buildAcpSessionAudit({ agentId: state.agentId, sessionId, phase: 'ended' }, Date.now()));
		}
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
				state?.log.applyTool({ toolCallId: event.toolCallId, title: event.title, name: event.name, toolKind: event.toolKind, status: event.status, paths: event.paths, diffs: event.diffs });
				if (state) {
					this._journalEdit(state, event.toolCallId, event.status);
					this._auditToolCall(state, event.toolCallId, event.status);
				}
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
					state.disconnected = true;
					this._audit(buildAcpSessionAudit({ agentId: state.agentId, sessionId: state.sessionId, phase: 'failed', error: event.error }, Date.now()));
					if (!this._surfaceVisible) {
						this._notifyDisconnected(state);
					}
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
			case 'config': {
				const state = this._sessions.get(event.sessionId);
				if (state) { state.configOptions = event.options; }
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
		const entry = settledToolEntry(state, toolCallId, status);
		const diffs = entry?.diffs ?? [];
		if (!entry || diffs.length === 0) { return; }
		const text = describeEdits(entry.title, diffs);
		if (status === 'failed') {
			this._activityLog.logError(localize('vibeide.acp.log.editFailed', "Правка внешнего агента не удалась: {0}", text));
		} else {
			this._activityLog.logFinished(text);
		}
	}

	/**
	 * A settled call goes to the audit log whether or not it edited anything: reading a secret or
	 * running a command is exactly what the log has to answer for. Built from the accumulated log entry
	 * for the same reason as the journal above — the finishing frame carries no diff.
	 */
	private _auditToolCall(state: ISessionState, toolCallId: string, status: string): void {
		const entry = settledToolEntry(state, toolCallId, status);
		if (!entry) { return; }
		this._audit(buildAcpToolCallAudit({
			agentId: state.agentId,
			sessionId: state.sessionId,
			toolCallId,
			title: entry.title,
			name: entry.name,
			toolKind: entry.toolKind,
			status: entry.status,
			paths: entry.paths,
			diffs: entry.diffs,
		}, Date.now()));
	}

	/** Writing the audit must never break the guest's turn: a failed write is dropped, not thrown. */
	private _audit(event: AuditEvent): void {
		if (!this._auditLog.isEnabled()) { return; }
		void this._auditLog.append(event).catch(() => { });
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
	 * A broken session while the tab is closed. Reconnecting right from the notification is safe:
	 * unlike a permission, nothing is decided on the person's behalf — the agent only comes back.
	 */
	private _notifyDisconnected(state: ISessionState): void {
		const sessionId = state.sessionId;
		this._notificationService.prompt(
			Severity.Warning,
			localize('vibeide.acp.disconnected.notify', "Связь с внешним агентом «{0}» оборвалась.", state.agentName),
			[
				{
					label: localize('vibeide.acp.reconnect', "Переподключить"),
					run: () => void this.reconnect(sessionId),
				},
				{
					label: localize('vibeide.acp.permission.show', "Показать"),
					run: () => void this._commandService.executeCommand(VIBE_ACP_SHOW_COMMAND_ID),
				},
			],
		);
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

/** What the person is told after a reconnection: above all, whether the agent remembers the conversation. */
export function reconnectNotice(mode: AcpReconnectMode): string {
	switch (mode) {
		case 'resume':
			return localize('vibeide.acp.reconnect.resumed', "Связь восстановлена: агент продолжил ту же сессию.");
		case 'load':
			return localize('vibeide.acp.reconnect.loaded', "Связь восстановлена: агент заново загрузил эту сессию и помнит разговор.");
		case 'new':
			return localize('vibeide.acp.reconnect.fresh', "Связь восстановлена, но агент не умеет продолжать сессию: начата новая, разговор выше он не помнит.");
	}
}

type AcpToolLogEntry = Extract<AcpLogEntry, { readonly kind: 'tool' }>;

/** The log entry of a call that has just settled; only `completed` and `failed` settle a call. */
function settledToolEntry(state: ISessionState, toolCallId: string, status: string): AcpToolLogEntry | undefined {
	if (status !== 'completed' && status !== 'failed') { return undefined; }
	const entry = state.log.snapshot.entries.find(item => item.kind === 'tool' && item.id === toolCallId);
	return entry?.kind === 'tool' ? entry : undefined;
}

registerSingleton(IVibeAcpSessionsService, VibeAcpSessionsService, InstantiationType.Delayed);
