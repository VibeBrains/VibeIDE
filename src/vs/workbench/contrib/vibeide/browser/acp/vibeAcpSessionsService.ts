/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Сессии внешних агентов: состояние для поверхности и ворота, через которые проходит их работа.
 *
 * Почему это одно место, а не два. На запрос разрешения есть ровно один ответ, и если бы его
 * могли дать и чат, и телефон, второй ответ уехал бы агенту в пустоту. Поэтому очередь
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
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { AcpEvent, IAcpAgentLaunch, IAcpPermissionRequest, IAcpReconnection, IAcpSession } from '../../common/acp/acpTypes.js';
import { AcpReconnectMode, AcpStopReason, agentCommandOf, IAcpCommand, IAcpConfigOption, IAcpDiff, IAcpPromptCapabilities } from '../../common/acp/acpProtocol.js';
import { ACP_EMBED_MAX_CHARS_DEFAULT, ACP_EMBED_MAX_CHARS_KEY, AcpContextItem, IAcpEditorState, buildAcpPromptBlocks } from '../../common/acp/acpPromptContext.js';
import { AcpLogEntry, AcpSessionLog, IAcpSessionSnapshot } from '../../common/acp/acpSessionLog.js';
import { buildAcpPermissionAudit, buildAcpSessionAudit, buildAcpToolCallAudit } from '../../common/acp/acpAudit.js';
import { AuditEvent, IAuditLogService } from '../../common/auditLogService.js';
import { IVibeAcpService } from '../../common/acp/vibeAcpService.js';
import { IVibeAcpIdeMcpService } from '../../common/acp/vibeAcpIdeMcpService.js';
import { IIdeMcpIssued } from '../../common/acp/acpIdeMcpTypes.js';
import { IRollbackSnapshotService } from '../../common/rollbackSnapshotService.js';
import { ISecretDetectionService } from '../../common/secretDetectionService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import {
	AcpDecisionReason,
	AcpGrant,
	AcpPermissionMode,
	DEFAULT_ACP_PERMISSION_MODE,
	IAcpRequestFacts,
	agentModeFor,
	autoAnswerOptionOf,
	decidePermission,
	grantOffersFor,
} from '../../common/acp/acpPermissionPolicy.js';
import { IVibeAgentActivityLogService } from '../vibeAgentActivityLogService.js';
import { IVibeAcpRegistryService } from './vibeAcpRegistryService.js';
import { VibeAgentEntry } from '../../common/acp/vibeAgentsFile.js';
import { BREVITY_SETTING, BrevityLevel, brevityForAgent, brevityLevelOf } from '../../common/prompt/brevity.js';

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
	/** Why this question was not answered by the mode or a grant, when that is worth telling the person */
	readonly pendingReason?: AcpDecisionReason;
	/** What the person may give for the rest of the session instead of answering this one time */
	readonly pendingGrantOffers: readonly AcpGrant[];
	readonly permissionMode: AcpPermissionMode;
	/** The permissions the person gave for this session */
	readonly grants: readonly AcpGrant[];
	/** The settings the agent exposes — model, mode, thinking — as it last reported them */
	readonly configOptions: readonly IAcpConfigOption[];
	/** A setting change is on its way to the agent: the controls wait for its answer */
	readonly configuring: boolean;
	/** The agent's own slash commands; one runs by being the task's text, `/name arguments` */
	readonly commands: readonly IAcpCommand[];
	/** Where the current (or the last) turn begins in `log.entries`: whoever mirrors the log follows it from there */
	readonly turnStart: number;
	/** What the agent accepts in a prompt, as it declared in the greeting */
	readonly promptCapabilities: IAcpPromptCapabilities;
}

/** A task for the agent: the person's words, and what of the editor goes along with them */
export interface IVibeAcpPromptRequest {
	readonly text: string;
	/** Pictures the person attached, base64 */
	readonly images?: readonly { readonly data: string; readonly mimeType: string }[];
	/** Absent for a task that comes from a messenger: the person is not at the editor, and its open file means nothing */
	readonly context?: {
		readonly items: readonly AcpContextItem[];
		readonly editor: IAcpEditorState;
		/** A path closed to the agent (`.vibe/ignore`) */
		readonly isHidden?: (path: string) => boolean;
	};
}

export interface IVibeAcpSessionsService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** Живые сессии в порядке открытия. */
	readonly sessions: readonly IVibeAcpSessionView[];

	startSession(agent: VibeAgentEntry): Promise<IAcpSession>;
	/**
	 * A session for a chat thread that already had one: the agent is started again and asked to come back to
	 * `previousSessionId` (the strongest way it declared), or to begin a new one when it cannot
	 * `mode` says which, because it says whether the agent still remembers the conversation
	 */
	resumeSession(agent: VibeAgentEntry, previousSessionId: string): Promise<{ readonly session: IAcpSession; readonly mode: AcpReconnectMode }>;
	prompt(sessionId: string, request: IVibeAcpPromptRequest): Promise<void>;
	/**
	 * The person's answer; `grant` — a permission for the rest of the session that goes with an allowing answer
	 * It has to be one the question offered: a surface cannot invent a wider permission than the one it was shown
	 */
	answerPermission(sessionId: string, optionId: string | undefined, grant?: AcpGrant): Promise<void>;
	/**
	 * The person's mode for this session: it answers by itself what it may, and keeps the agent asking about the rest
	 * `plan` is also set on the agent, whose own planning mode changes what it does
	 */
	setPermissionMode(sessionId: string, mode: AcpPermissionMode): Promise<void>;
	/** Withdraw the permissions given for this session */
	clearGrants(sessionId: string): void;
	/**
	 * The slash commands an agent announced: from its live session, else as they were the last time any session of it said them
	 * An agent announces its commands only after the session starts, so a conversation that has not begun yet would show none
	 */
	commandsOf(agentId: string): readonly IAcpCommand[];
	cancel(sessionId: string): Promise<void>;
	endSession(sessionId: string): Promise<void>;
	/** Change a setting the agent exposes; the card shows the state the agent answers with, not the value asked for */
	setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<void>;
	/**
	 * Bring back a session whose agent process died, without restarting the IDE. The transcript stays;
	 * a note in it says whether the agent still remembers the conversation. With a new session the id
	 * changes — the card stays in its place under the new id.
	 */
	reconnect(sessionId: string): Promise<string | undefined>;
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
	pending?: { readonly request: IAcpPermissionRequest; readonly snapshotId?: string; readonly reason?: AcpDecisionReason; readonly offers: readonly AcpGrant[] };
	permissionMode: AcpPermissionMode;
	grants: AcpGrant[];
	configOptions: readonly IAcpConfigOption[];
	configuring: boolean;
	commands: readonly IAcpCommand[];
	/** What the agent accepts in a prompt, as it declared in the greeting */
	promptCapabilities: IAcpPromptCapabilities;
	turnStart: number;
	/** The entry of the editor's MCP server handed to this session; kept across a reconnection, withdrawn when the session ends */
	ideMcp?: IIdeMcpIssued;
	/** The «Краткие ответы» level the agent was last given; undefined — it has not been told anything */
	brevitySent?: BrevityLevel;
}

export class VibeAcpSessionsService extends Disposable implements IVibeAcpSessionsService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _sessions = new Map<string, ISessionState>();
	/** The commands each agent last announced, by agent id: they outlive the session and the window */
	private _knownCommands: Readonly<Record<string, readonly IAcpCommand[]>>;
	/** Questions withdrawn while their checkpoint was still being taken: they must not open a card afterwards */
	private readonly _withdrawnBeforeShown = new Set<string>();

	constructor(
		@IVibeAcpService private readonly _acpService: IVibeAcpService,
		@IVibeAcpIdeMcpService private readonly _ideMcp: IVibeAcpIdeMcpService,
		@IVibeAcpRegistryService private readonly _registry: IVibeAcpRegistryService,
		@IRollbackSnapshotService private readonly _snapshotService: IRollbackSnapshotService,
		@IVibeAgentActivityLogService private readonly _activityLog: IVibeAgentActivityLogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IAuditLogService private readonly _auditLog: IAuditLogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISecretDetectionService private readonly _secretDetection: ISecretDetectionService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._register(this._acpService.onEvent(event => this._observe(event)));
		this._knownCommands = parseKnownCommands(this._storageService.get(KNOWN_COMMANDS_STORAGE_KEY, StorageScope.WORKSPACE));
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
			pendingReason: state.pending?.reason,
			pendingGrantOffers: state.pending?.offers ?? [],
			permissionMode: state.permissionMode,
			grants: state.grants,
			configOptions: state.configOptions,
			configuring: state.configuring,
			commands: state.commands,
			turnStart: state.turnStart,
			promptCapabilities: state.promptCapabilities,
		}));
	}

	async startSession(agent: VibeAgentEntry): Promise<IAcpSession> {
		const launch = this._registry.launchOf(agent);
		if (!launch) {
			throw new Error(localize('vibeide.acp.noWorkspace', "Открытой рабочей папки нет — агенту негде работать."));
		}
		const ideMcp = await this._ideMcp.issue();
		let session: IAcpSession;
		try {
			session = await this._acpService.startSession(withIdeMcp(launch, ideMcp));
		} catch (err) {
			if (ideMcp) { void this._ideMcp.revoke(ideMcp.token); }
			throw err;
		}
		this._adopt(agent, session, ideMcp);
		return session;
	}

	async resumeSession(agent: VibeAgentEntry, previousSessionId: string): Promise<{ readonly session: IAcpSession; readonly mode: AcpReconnectMode }> {
		const launch = this._registry.launchOf(agent);
		if (!launch) {
			throw new Error(localize('vibeide.acp.noWorkspace', "Открытой рабочей папки нет — агенту негде работать."));
		}
		const ideMcp = await this._ideMcp.issue();
		let back: IAcpReconnection;
		try {
			back = await this._acpService.reconnectSession(previousSessionId, withIdeMcp(launch, ideMcp));
		} catch (err) {
			if (ideMcp) { void this._ideMcp.revoke(ideMcp.token); }
			throw err;
		}
		this._adopt(agent, back, ideMcp);
		return { session: back, mode: back.mode };
	}

	/** A session the agent opened, taken into the list: the state the surfaces read, and the first lines of the journals */
	private _adopt(agent: VibeAgentEntry, session: IAcpSession, ideMcp: IIdeMcpIssued | undefined): void {
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
			commands: session.commands ?? [],
			promptCapabilities: session.promptCapabilities,
			turnStart: 0,
			permissionMode: DEFAULT_ACP_PERMISSION_MODE,
			grants: [],
			ideMcp,
		});
		if (session.commands) { this._rememberCommands(agent.id, session.commands); }
		this._activityLog.logStarted(localize('vibeide.acp.log.session', "Внешний агент «{0}» открыл сессию", session.agentName));
		this._audit(buildAcpSessionAudit({ agentId: agent.id, sessionId: session.sessionId, phase: 'started' }, Date.now()));
		this._onDidChange.fire();
	}

	async prompt(sessionId: string, request: IVibeAcpPromptRequest): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state || state.busy) { return; }
		if (state.disconnected) {
			// The dead process cannot take the task; saying so beats a bare «session not found».
			state.error = localize('vibeide.acp.disconnected.prompt', "Связь с агентом оборвалась — переподключите его, чтобы отправить задачу.");
			this._onDidChange.fire();
			return;
		}
		state.turnStart = state.log.beginTurn();
		state.busy = true;
		state.error = undefined;
		state.lastStopReason = undefined;
		this._onDidChange.fire();
		// The agent keeps its own history, so the style goes once and again only on a change of level
		// An agent command runs only as the first word of the task: the note waits for the next ordinary task
		const brevity = brevityLevelOf(this._configurationService.getValue(BREVITY_SETTING));
		const command = agentCommandOf(request.text, state.commands);
		const note = command ? undefined : brevityForAgent(state.brevitySent, brevity);
		try {
			const blocks = buildAcpPromptBlocks({
				text: request.text,
				note,
				commands: state.commands,
				capabilities: state.promptCapabilities,
				embedMaxChars: this._configurationService.getValue<number>(ACP_EMBED_MAX_CHARS_KEY) ?? ACP_EMBED_MAX_CHARS_DEFAULT,
				items: request.context?.items ?? [],
				images: request.images,
				editor: request.context?.editor,
				isHidden: request.context?.isHidden,
				redact: text => this._secretDetection.detectSecrets(text).redactedText,
			});
			state.lastStopReason = await this._acpService.prompt(sessionId, blocks);
			if (!command) {
				state.brevitySent = brevity;
			}
		} catch (err) {
			state.error = err instanceof Error ? err.message : String(err);
		} finally {
			state.busy = false;
			state.log.settleTurn();
			this._onDidChange.fire();
		}
	}

	/**
	 * Ответ человека. `undefined` — отказ.
	 *
	 * Отказ отбрасывает чекпоинт: правки, к которой он относился, не случилось.
	 */
	async answerPermission(sessionId: string, optionId: string | undefined, grant?: AcpGrant): Promise<void> {
		const state = this._sessions.get(sessionId);
		const pending = state?.pending;
		if (!state || !pending) { return; }
		state.pending = undefined;
		const request = pending.request;
		const optionKind = optionId ? request.options.find(option => option.optionId === optionId)?.kind : undefined;
		// A permission for the session goes only with an allowing answer, and only if the question offered it
		if (grant && optionKind?.startsWith('allow') && pending.offers.some(offer => JSON.stringify(offer) === JSON.stringify(grant))) {
			state.grants = [...state.grants, grant];
		}
		this._onDidChange.fire();

		await this._acpService.answerPermission(request.requestId, optionId);
		this._audit(buildAcpPermissionAudit({
			agentId: state.agentId,
			sessionId,
			toolCallId: request.toolCallId,
			title: request.title,
			name: request.name,
			toolKind: request.toolKind,
			paths: request.paths,
			optionKind,
		}, Date.now()));
		// A refusal — the person's cancel or the agent's own «reject» option — means the edit did not happen
		if ((!optionId || optionKind?.startsWith('reject')) && pending.snapshotId) {
			await this._snapshotService.discardSnapshot(pending.snapshotId);
		}
	}

	async setPermissionMode(sessionId: string, mode: AcpPermissionMode): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state) { return; }
		state.permissionMode = mode;
		this._onDidChange.fire();
		const setting = state.configOptions.find(option => option.type === 'select' && (option.id === 'mode' || option.category === 'mode'));
		if (setting?.type !== 'select') { return; }
		const wanted = agentModeFor(mode, setting.choices);
		if (wanted && wanted !== setting.currentValue) {
			await this.setConfigOption(sessionId, setting.id, wanted);
		}
	}

	commandsOf(agentId: string): readonly IAcpCommand[] {
		const live = [...this._sessions.values()].find(state => state.agentId === agentId && state.commands.length > 0);
		return live?.commands ?? this._knownCommands[agentId] ?? [];
	}

	private _rememberCommands(agentId: string, commands: readonly IAcpCommand[]): void {
		if (commands.length === 0) { return; }
		this._knownCommands = { ...this._knownCommands, [agentId]: commands };
		this._storageService.store(KNOWN_COMMANDS_STORAGE_KEY, JSON.stringify(this._knownCommands), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	clearGrants(sessionId: string): void {
		const state = this._sessions.get(sessionId);
		if (!state || state.grants.length === 0) { return; }
		state.grants = [];
		this._onDidChange.fire();
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

	async reconnect(sessionId: string): Promise<string | undefined> {
		const state = this._sessions.get(sessionId);
		if (!state || !state.disconnected || state.reconnecting) { return undefined; }
		// The launch is read again, not remembered: the entry in agents.json may have changed since.
		const agent = this._registry.agents.find(entry => entry.id === state.agentId);
		const launch = agent ? this._registry.launchOf(agent) : undefined;
		if (!agent || !launch) {
			state.error = agent
				? localize('vibeide.acp.noWorkspace', "Открытой рабочей папки нет — агенту негде работать.")
				: localize('vibeide.acp.reconnect.gone', "Агента «{0}» больше нет в .vibe/agents.json — переподключать некого.", state.agentName);
			this._onDidChange.fire();
			return undefined;
		}
		state.reconnecting = true;
		state.error = undefined;
		this._onDidChange.fire();
		let current = state;
		try {
			const back = await this._acpService.reconnectSession(sessionId, withIdeMcp(launch, state.ideMcp));
			if (back.sessionId !== sessionId) {
				current = { ...state, sessionId: back.sessionId };
				this._rekey(sessionId, current);
			}
			current.disconnected = false;
			current.busy = false;
			// A new process may expose other settings and commands; an agent that reported none keeps showing none
			current.configOptions = back.configOptions ?? [];
			current.commands = back.commands ?? [];
			current.promptCapabilities = back.promptCapabilities;
			// A fresh session has none of the old history, the style included
			if (back.mode === 'new') {
				current.brevitySent = undefined;
				// The permissions were given for a conversation the agent no longer has
				current.grants = [];
			}
			current.log.appendNotice(reconnectNotice(back.mode));
			this._activityLog.logStarted(localize('vibeide.acp.log.reconnected', "Внешний агент «{0}» переподключён", current.agentName));
			this._audit(buildAcpSessionAudit({ agentId: current.agentId, sessionId: current.sessionId, phase: 'reconnected', reconnectMode: back.mode }, Date.now()));
		} catch (err) {
			current.error = localize('vibeide.acp.reconnect.failed', "Переподключить не удалось: {0}", err instanceof Error ? err.message : String(err));
		} finally {
			current.reconnecting = false;
			this._onDidChange.fire();
		}
		return current.disconnected ? undefined : current.sessionId;
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
		if (state?.ideMcp) {
			void this._ideMcp.revoke(state.ideMcp.token);
		}
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
				state?.log.applyTool({ toolCallId: event.toolCallId, title: event.title, name: event.name, toolKind: event.toolKind, status: event.status, paths: event.paths, diffs: event.diffs, output: event.output, exitCode: event.exitCode });
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
			case 'permissionWithdrawn':
				void this._withdrawn(event.sessionId, event.requestId);
				return;
			case 'commands': {
				const state = this._sessions.get(event.sessionId);
				if (state) {
					state.commands = event.commands;
					this._rememberCommands(state.agentId, event.commands);
				}
				this._onDidChange.fire();
				return;
			}
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

	/** Чекпоинт по путям правки, затем решение: ответ по режиму и разрешениям сессии или вопрос человеку. */
	private async _guard(request: IAcpPermissionRequest): Promise<void> {
		const state = this._sessions.get(request.sessionId);
		if (!state) {
			// Сессия не наша (например, осталась от прошлого окна): отвечаем отказом, иначе агент
			// будет ждать вечно.
			await this._acpService.answerPermission(request.requestId, undefined);
			return;
		}
		// The checkpoint is taken for an answer given by the mode as well: it is what the edit can be undone from
		const snapshotId = await this._snapshotBefore(request);
		if (this._withdrawnBeforeShown.delete(request.requestId)) {
			if (snapshotId) { await this._snapshotService.discardSnapshot(snapshotId); }
			return;
		}
		const facts: IAcpRequestFacts = { toolKind: request.toolKind, name: request.name, title: request.title, command: request.command, paths: request.paths };
		const roots = this._workspace.getWorkspace().folders.map(folder => folder.uri.fsPath);
		const decision = decidePermission(facts, { mode: state.permissionMode, grants: state.grants, roots });
		const autoOption = decision.action === 'allow' ? autoAnswerOptionOf(request.options) : undefined;
		if (autoOption) {
			await this._acpService.answerPermission(request.requestId, autoOption);
			this._audit(buildAcpPermissionAudit({
				agentId: state.agentId,
				sessionId: state.sessionId,
				toolCallId: request.toolCallId,
				title: request.title,
				name: request.name,
				toolKind: request.toolKind,
				paths: request.paths,
				optionKind: request.options.find(option => option.optionId === autoOption)?.kind,
				decidedBy: 'policy',
				reason: decision.reason,
			}, Date.now()));
			this._activityLog.logFinished(localize('vibeide.acp.log.autoAllowed', "Внешнему агенту разрешено без вопроса: {0}", request.title));
			return;
		}
		state.pending = { request, ...(snapshotId ? { snapshotId } : {}), ...(decision.action === 'ask' ? { reason: decision.reason } : {}), offers: grantOffersFor(facts, roots) };
		this._activityLog.logStarted(localize('vibeide.acp.log.asks', "Внешний агент просит разрешения: {0}", request.title));
		this._onDidChange.fire();
	}

	/**
	 * The question closed without a person's answer: the agent withdrew it, or the turn was stopped
	 * The edit it asked about did not happen, so its checkpoint goes, as on a refusal
	 */
	private async _withdrawn(sessionId: string, requestId: string): Promise<void> {
		const state = this._sessions.get(sessionId);
		if (!state) { return; }
		const pending = state.pending;
		if (pending?.request.requestId !== requestId) {
			// Still being shown: the checkpoint is being taken, and the card must not open once it is
			this._withdrawnBeforeShown.add(requestId);
			return;
		}
		state.pending = undefined;
		this._activityLog.logFinished(localize('vibeide.acp.log.withdrawn', "Вопрос внешнего агента снят без ответа: {0}", pending.request.title));
		this._onDidChange.fire();
		if (pending.snapshotId) {
			await this._snapshotService.discardSnapshot(pending.snapshotId);
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
}

const KNOWN_COMMANDS_STORAGE_KEY = 'vibeide.acp.knownAgentCommands';

/** The stored commands of every agent; a record of another shape is dropped, not trusted */
function parseKnownCommands(raw: string | undefined): Record<string, readonly IAcpCommand[]> {
	if (!raw) { return {}; }
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== 'object' || Array.isArray(value)) { return {}; }
		const result: Record<string, readonly IAcpCommand[]> = {};
		for (const [agentId, commands] of Object.entries(value)) {
			if (!Array.isArray(commands)) { continue; }
			result[agentId] = commands.filter((command): command is IAcpCommand => !!command && typeof command.name === 'string' && typeof command.description === 'string');
		}
		return result;
	} catch {
		return {};
	}
}

/** The launch with the editor's MCP server among the agent's servers, when the person allows the tools */
function withIdeMcp(launch: IAcpAgentLaunch, ideMcp: IIdeMcpIssued | undefined): IAcpAgentLaunch {
	return ideMcp ? { ...launch, mcpServers: [...(launch.mcpServers ?? []), ideMcp.server] } : launch;
}

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
