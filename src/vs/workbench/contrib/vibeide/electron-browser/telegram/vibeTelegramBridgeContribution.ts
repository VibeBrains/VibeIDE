/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../../base/common/async.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { basename } from '../../../../../base/common/resources.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IChatThreadService } from '../../browser/chatThreadService.js';
import { vibeLog } from '../../common/vibeLog.js';
import { parseTelegramCommand, resolveProjectChoice } from '../../common/telegram/telegramCommandParse.js';
import { generatePairingCode } from '../../common/telegram/telegramPairing.js';
import { resolveVoiceProfile } from '../../common/voice/vibeVoiceModels.js';
import { escapeTelegramHtml, formatProgressLine, formatToolRequestPreview, markdownToTelegramHtml, splitForTelegram } from '../../common/telegram/telegramFormat.js';
import { shouldMirrorApproval, VibeTelegramApprovalPolicy } from '../../common/telegram/telegramApprovalPolicy.js';
import { approvalTypeOfBuiltinToolName } from '../../common/prompt/tools/index.js';
import {
	IVibeTelegramMain,
	VIBE_TELEGRAM_CHANNEL,
	VIBE_TELEGRAM_PROGRESS_INTERVAL_MS,
	VIBE_TELEGRAM_APPROVAL_TIMEOUT_MS,
	VIBE_TELEGRAM_TOKEN_SECRET_KEY,
	VibeTelegramApprovalDecision,
	VibeTelegramConfigKeys,
} from '../../common/telegram/vibeTelegramTypes.js';

/** One approval request live in a chat: what it belongs to and how to close it. */
interface PendingApproval {
	readonly threadId: string;
	readonly chatId: number;
	/** Id of the tool call being approved — tells a new question from a repeated stream event. */
	readonly toolCallId: string;
	/** Telegram message carrying the buttons, edited in place once the request is settled. */
	readonly messageId: number | undefined;
	readonly timer: IDisposable;
}

/**
 * Window side of the Telegram bridge: it owns configuration and secrets, announces this window
 * to the poller in the main process, and executes the commands routed back to it.
 *
 * The poller itself is deliberately NOT here — see `common/telegram/vibeTelegramTypes.ts`.
 */
export class VibeTelegramBridgeContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'vibeide.telegramBridge';

	private readonly _main: IVibeTelegramMain;
	/** Runs started from Telegram: thread id → the chat and progress message to update. */
	private readonly _activeRuns = new Map<string, { chatId: number; progressMessageId?: number; startedAtMs: number; lastEditMs: number }>();
	/** Approval requests currently shown in a chat, by the token carried on their buttons. */
	private readonly _pendingApprovals = new Map<string, PendingApproval>();
	/** Threads whose next chat message is a correction of a refused tool call, not a new task. */
	private readonly _awaitingAmendment = new Map<number, string>();
	/** Timers that turn an unanswered approval into a refusal; disposed with the window. */
	private readonly _approvalTimers = this._register(new DisposableStore());
	private _approvalCounter = 0;
	private _windowId: number | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ISecretStorageService private readonly _secrets: ISecretStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();
		this._main = ProxyChannel.toService<IVibeTelegramMain>(mainProcessService.getChannel(VIBE_TELEGRAM_CHANNEL));

		this._register(this._main.onDidReceiveCommand(e => {
			if (e.windowId !== this._windowId) {
				return;
			}
			if (e.voiceFileId) {
				void this._executeVoice(e.chatId, e.voiceFileId);
				return;
			}
			void this._executeCommand(e.chatId, e.text);
		}));
		this._register(this._main.onDidRequestBinding(e => void this._askToBind(e.chatId, e.from)));
		this._register(this._main.onDidAnswerApproval(e => void this._onApprovalAnswered(e.token, e.decision, e.chatId)));
		this._register(this._chatThreadService.onDidChangeStreamState(e => void this._onStreamStateChanged(e.threadId)));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VibeTelegramConfigKeys.section)) {
				void this._applyConfig();
			}
		}));
		// The token lives in the secret store, not in settings, so a new token produces no
		// configuration event — without this the bridge would keep polling with the old one
		// (or stay silent) until the window was reloaded.
		this._register(this._secrets.onDidChangeSecret(key => {
			if (key === VIBE_TELEGRAM_TOKEN_SECRET_KEY) {
				void this._applyConfig();
			}
		}));

		void this._start();
	}

	private async _start(): Promise<void> {
		this._windowId = this._nativeHostService.windowId;
		await this._registerWindow();
		await this._applyConfig();
	}

	private async _registerWindow(): Promise<void> {
		if (this._windowId === undefined) {
			return;
		}
		const folder = this._workspaceService.getWorkspace().folders[0];
		await this._main.registerWindow({
			windowId: this._windowId,
			projectName: folder ? basename(folder.uri) : undefined,
			projectPath: folder?.uri.fsPath,
		});
	}

	/** Pushes settings + token into the poller and starts or stops it accordingly. */
	private async _applyConfig(): Promise<void> {
		const enabled = this._configurationService.getValue<boolean>(VibeTelegramConfigKeys.enabled) === true;
		const token = await this._secrets.get(VIBE_TELEGRAM_TOKEN_SECRET_KEY);
		const pairingCode = await this._ensurePairingCode();
		await this._main.setConfig({
			token: enabled ? token : undefined,
			proxyUrl: this._configurationService.getValue<string>(VibeTelegramConfigKeys.proxyUrl) || undefined,
			allowedChatIds: this._configurationService.getValue<number[]>(VibeTelegramConfigKeys.allowedChatIds) ?? [],
			pairingCode,
			// Same setting the in-IDE dictation uses, so a voice message and the microphone are
			// never recognised in different languages.
			voiceProfile: resolveVoiceProfile(this._configurationService.getValue<unknown>('accessibility.voice.speechLanguage')),
		});

		if (!enabled) {
			await this._main.stop();
			return;
		}
		if (!token) {
			// Enabled without a token is a dead end the user cannot diagnose from the UI, so say it.
			this._notificationService.warn(localize('vibeide.telegram.noToken', "Мост в Telegram включён, но токен бота не задан. Выполните «VibeIDE: Токен Telegram-бота»."));
			return;
		}
		const status = await this._main.start();
		if (status.state === 'error') {
			this._notificationService.error(localize('vibeide.telegram.startFailed', "Мост в Telegram не запустился: {0}", status.error ?? ''));
		} else if (status.state === 'listening') {
			vibeLog.info('Telegram', `bridge listening as ${status.botUsername ?? 'бот'}`);
		}
	}

	/**
	 * The pairing code, generated on first use. Without it an unbound chat is ignored entirely,
	 * so an empty code must never reach the poller — that would mean "anyone may ask".
	 */
	private async _ensurePairingCode(): Promise<string> {
		const existing = this._configurationService.getValue<string>(VibeTelegramConfigKeys.pairingCode);
		if (existing) {
			return existing;
		}
		const code = generatePairingCode(max => Math.floor(Math.random() * max));
		await this._configurationService.updateValue(VibeTelegramConfigKeys.pairingCode, code);
		return code;
	}

	/**
	 * An unknown chat wrote to the bot. Nothing is executed until the owner agrees — otherwise
	 * anyone who guessed the bot name would be running tools on this machine.
	 */
	private async _askToBind(chatId: number, from: string | undefined): Promise<void> {
		const who = from ? `${from} (id ${chatId})` : `id ${chatId}`;
		const { confirmed } = await this._dialogService.confirm({
			type: Severity.Warning,
			message: localize('vibeide.telegram.bindTitle', "Разрешить этому чату управлять агентом?"),
			detail: localize('vibeide.telegram.bindDetail', "В Telegram-бота написал {0}. Разрешение даёт этому чату право ставить задачи агенту и запускать инструменты на этом компьютере. Разрешайте только свой чат.", who),
			primaryButton: localize('vibeide.telegram.bindAllow', "Разрешить"),
			cancelButton: localize('vibeide.telegram.bindDeny', "Отклонить"),
		});
		if (!confirmed) {
			return;
		}
		const current = this._configurationService.getValue<number[]>(VibeTelegramConfigKeys.allowedChatIds) ?? [];
		if (!current.includes(chatId)) {
			await this._configurationService.updateValue(VibeTelegramConfigKeys.allowedChatIds, [...current, chatId]);
		}
		await this._applyConfig();
		await this._main.send({ chatId, text: markdownToTelegramHtml('Чат привязан. Напиши задачу текстом или `/help` — покажу команды.') });
	}

	/**
	 * A voice message: transcribe locally, then treat the transcript exactly like typed text.
	 * The transcript is echoed back first — recognition is never perfect, and seeing what the
	 * agent was actually asked beats wondering why it did something else.
	 */
	private async _executeVoice(chatId: number, voiceFileId: string): Promise<void> {
		const readiness = await this._main.getVoiceReadiness();
		if (readiness.state === 'needsDownload') {
			// Said once, before the wait: a silent minute of downloading reads as a hung bridge.
			await this._reply(chatId, `🎧 Первое голосовое: скачиваю распознавание (~${readiness.downloadMb} МБ). Дальше будет сразу.`);
		} else if (readiness.state !== 'ready') {
			await this._reply(chatId, readiness.detail);
			if (readiness.state === 'unsupported') {
				return;
			}
		}

		const notice = await this._main.send({ chatId, text: '🎧 Распознаю…' });
		const result = await this._main.transcribeVoice(voiceFileId);
		if (!result.ok) {
			await this._main.send({ chatId, editMessageId: notice.messageId, text: `❌ ${result.reason}` });
			return;
		}
		await this._main.send({ chatId, editMessageId: notice.messageId, text: `🎧 «${result.text}»` });
		await this._executeCommand(chatId, result.text);
	}

	// --- commands --------------------------------------------------------------------------

	private async _executeCommand(chatId: number, rawText: string): Promise<void> {
		const command = parseTelegramCommand(rawText);
		// A correction promised after "✏️ Поправить" goes into the thread that was refused, so the
		// agent still knows what it was denied. Commands stay commands — `/stop` must work even
		// while a correction is expected, or a wrong run could not be stopped from the phone.
		const amendThreadId = this._awaitingAmendment.get(chatId);
		if (amendThreadId !== undefined && command.kind === 'run') {
			this._awaitingAmendment.delete(chatId);
			await this._continueThread(chatId, amendThreadId, command.prompt);
			return;
		}
		switch (command.kind) {
			case 'empty':
				return;
			case 'start':
			case 'help':
				await this._reply(chatId, HELP_TEXT);
				return;
			case 'projects':
				await this._replyProjects(chatId);
				return;
			case 'use':
				await this._useProject(chatId, command.project);
				return;
			case 'status':
				await this._replyStatus(chatId);
				return;
			case 'stop':
				await this._stopRun(chatId);
				return;
			case 'run':
				await this._run(chatId, command.prompt);
				return;
		}
	}

	private async _replyProjects(chatId: number): Promise<void> {
		const windows = await this._main.listWindows();
		if (!windows.length) {
			await this._reply(chatId, 'Открытых окон нет.');
			return;
		}
		const lines = windows.map(w => `• ${w.projectName ?? 'без проекта'}${w.windowId === this._windowId ? ' — сюда идут команды' : ''}`);
		await this._reply(chatId, `Открытые окна:\n${lines.join('\n')}\n\nПереключиться: /use <имя>`);
	}

	private async _useProject(chatId: number, query: string): Promise<void> {
		const windows = await this._main.listWindows();
		const choice = resolveProjectChoice(windows, query);
		if (!choice) {
			await this._reply(chatId, `Не нашёл проект «${query}». Список: /projects`);
			return;
		}
		if ('ambiguous' in choice) {
			const names = choice.ambiguous.map(w => w.projectName).join(', ');
			await this._reply(chatId, `Под «${query}» подходит несколько: ${names}. Уточни.`);
			return;
		}
		await this._main.bindChatToWindow(chatId, choice.match.windowId);
		await this._reply(chatId, `Команды идут в проект ${choice.match.projectName}.`);
	}

	private async _replyStatus(chatId: number): Promise<void> {
		const folder = this._workspaceService.getWorkspace().folders[0];
		const running = [...this._activeRuns.entries()].filter(([threadId]) => !!this._chatThreadService.streamState[threadId]?.isRunning);
		const where = folder ? basename(folder.uri) : 'окно без проекта';
		await this._reply(chatId, running.length
			? `Проект: ${where}. Прогонов из Telegram в работе: ${running.length}.`
			: `Проект: ${where}. Активных прогонов из Telegram нет.`);
	}

	private async _stopRun(chatId: number): Promise<void> {
		const entry = [...this._activeRuns.entries()].find(([, run]) => run.chatId === chatId);
		if (!entry) {
			await this._reply(chatId, 'Нечего останавливать.');
			return;
		}
		await this._chatThreadService.abortRunning(entry[0]);
		await this._reply(chatId, 'Прогон остановлен.');
	}

	private async _run(chatId: number, prompt: string): Promise<void> {
		await this._continueThread(chatId, this._chatThreadService.getCurrentThread().id, prompt);
	}

	/** Sends a message into a specific thread and mirrors that run back into the chat. */
	private async _continueThread(chatId: number, threadId: string, prompt: string): Promise<void> {
		const now = Date.now();
		this._activeRuns.set(threadId, { chatId, startedAtMs: now, lastEditMs: 0 });
		const started = await this._main.send({ chatId, text: formatProgressLine(0, undefined) });
		if (started.ok && started.messageId !== undefined) {
			const run = this._activeRuns.get(threadId);
			if (run) {
				this._activeRuns.set(threadId, { ...run, progressMessageId: started.messageId });
			}
		}

		try {
			await this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: prompt, threadId });
		} catch (e) {
			this._activeRuns.delete(threadId);
			await this._reply(chatId, `Не смог запустить: ${(e as Error).message}`);
		}
	}

	// --- run progress ----------------------------------------------------------------------

	/**
	 * Mirrors a run into the chat: the progress line is edited in place while the run is alive,
	 * and the final answer is sent once it ends. Editing rather than sending keeps a long run
	 * from turning into a wall of notifications on the phone.
	 */
	private async _onStreamStateChanged(threadId: string): Promise<void> {
		const run = this._activeRuns.get(threadId);
		if (!run) {
			return;
		}
		const state = this._chatThreadService.streamState[threadId];

		if (state?.isRunning === 'awaiting_user') {
			await this._mirrorApprovalRequest(threadId, run.chatId);
			return;
		}
		// Any other transition means the request is no longer pending — most often because the
		// owner answered it in the IDE. Leaving live buttons on the phone would let a later tap
		// approve whatever the run has moved on to.
		this._settleApprovalsOfThread(threadId, 'Решено в IDE.');

		if (state?.isRunning) {
			const interval = this._configurationService.getValue<number>(VibeTelegramConfigKeys.progressIntervalMs) ?? VIBE_TELEGRAM_PROGRESS_INTERVAL_MS;
			const now = Date.now();
			// The FIRST update is not throttled: a run that ends quickly would otherwise leave
			// "Работаю 0 с" on the phone forever, which reads as a hung bridge rather than a
			// finished job. Subsequent updates keep the interval so the chat is not spammed.
			const isFirstUpdate = run.lastEditMs === 0;
			if (run.progressMessageId === undefined || (!isFirstUpdate && now - run.lastEditMs < interval)) {
				return;
			}
			this._activeRuns.set(threadId, { ...run, lastEditMs: now });
			const activity = state.isRunning === 'tool' ? state.toolInfo?.toolName : undefined;
			await this._main.send({
				chatId: run.chatId,
				editMessageId: run.progressMessageId,
				text: formatProgressLine(now - run.startedAtMs, activity),
			});
			return;
		}

		this._activeRuns.delete(threadId);
		if (state?.error) {
			await this._reply(run.chatId, `❌ Прогон завершился ошибкой: ${state.error.message}`);
			return;
		}
		await this._reply(run.chatId, this._lastAssistantText(threadId) ?? '✅ Готово.');
	}

	// --- approvals -------------------------------------------------------------------------

	/**
	 * A run stopped to ask permission. Shows WHAT is about to happen and the buttons under it —
	 * an approval reduced to "allow action #3" is not a decision, it is a reflex.
	 *
	 * Nothing here can approve anything: a request the policy does not mirror simply keeps
	 * waiting in the IDE.
	 */
	private async _mirrorApprovalRequest(threadId: string, chatId: number): Promise<void> {
		const thread = this._chatThreadService.state.allThreads[threadId];
		const lastMessage = thread?.messages[thread.messages.length - 1];
		if (!lastMessage || lastMessage.role !== 'tool' || lastMessage.type !== 'tool_request') {
			return;
		}
		// The same thread re-enters `awaiting_user` on every stream event while it waits, so the
		// tool call id — not the state — is what tells a new question from a repeated one.
		for (const pending of this._pendingApprovals.values()) {
			if (pending.threadId === threadId && pending.toolCallId === lastMessage.id) {
				return;
			}
		}

		const policy = this._configurationService.getValue<VibeTelegramApprovalPolicy>(VibeTelegramConfigKeys.approvals) ?? 'all';
		const approvalType = approvalTypeOfBuiltinToolName[lastMessage.name as keyof typeof approvalTypeOfBuiltinToolName]
			?? (lastMessage.mcpServerName ? 'MCP tools' : undefined);
		if (!shouldMirrorApproval(approvalType, policy)) {
			return;
		}

		const token = `a${++this._approvalCounter}`;
		const preview = formatToolRequestPreview(lastMessage.name, lastMessage.rawParams);
		const delivered = await this._main.send({
			chatId,
			text: markdownToTelegramHtml(preview),
			approval: { token },
		});
		if (!delivered.ok) {
			return;
		}

		const timeoutMs = VIBE_TELEGRAM_APPROVAL_TIMEOUT_MS;
		const timer = disposableTimeout(() => void this._onApprovalAnswered(token, 'reject', chatId, true), timeoutMs);
		this._approvalTimers.add(timer);
		this._pendingApprovals.set(token, {
			threadId,
			chatId,
			toolCallId: lastMessage.id,
			messageId: delivered.messageId,
			timer,
		});
	}

	/** Answer from the phone: a tap on one of the three buttons, or the timeout acting as a refusal. */
	private async _onApprovalAnswered(token: string, decision: VibeTelegramApprovalDecision, chatId: number | undefined, byTimeout = false): Promise<void> {
		const pending = this._pendingApprovals.get(token);
		if (!pending || (chatId !== undefined && chatId !== pending.chatId)) {
			return;
		}
		this._closeApproval(token, pending, byTimeout
			? '⏱ Никто не ответил — действие отклонено.'
			: decision === 'approve' ? '✅ Разрешено.' : decision === 'amend' ? '✏️ Отклонено — жду, как поправить.' : '⛔️ Отклонено.');

		if (decision === 'approve') {
			this._chatThreadService.approveLatestToolRequest(pending.threadId);
			return;
		}
		this._chatThreadService.rejectLatestToolRequest(pending.threadId);
		if (decision === 'amend') {
			// The correction goes into the same thread as an ordinary message: the agent keeps the
			// context of what it was denied, which is the whole point of amending instead of
			// rejecting and retyping the task.
			this._awaitingAmendment.set(pending.chatId, pending.threadId);
			await this._reply(pending.chatId, 'Напиши или наговори, что сделать вместо этого.');
		}
	}

	/** Drops still-open requests of a thread, replacing their buttons with the given outcome. */
	private _settleApprovalsOfThread(threadId: string, outcome: string): void {
		for (const [token, pending] of [...this._pendingApprovals]) {
			if (pending.threadId === threadId) {
				this._closeApproval(token, pending, outcome);
			}
		}
	}

	/**
	 * Removes the request from the map and rewrites its message to the outcome. Editing without
	 * `approval` also strips the keyboard, so a stale button cannot be tapped afterwards.
	 */
	private _closeApproval(token: string, pending: PendingApproval, outcome: string): void {
		this._pendingApprovals.delete(token);
		// `DisposableStore.delete` disposes as it removes — the timer must not fire after the
		// request it belonged to is gone.
		this._approvalTimers.delete(pending.timer);
		if (pending.messageId !== undefined) {
			void this._main.send({ chatId: pending.chatId, editMessageId: pending.messageId, text: escapeTelegramHtml(outcome) });
		}
	}

	/** Text of the last assistant message, for delivering the answer to the phone. */
	private _lastAssistantText(threadId: string): string | undefined {
		const thread = this._chatThreadService.state.allThreads[threadId];
		const messages = thread?.messages ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === 'assistant' && message.displayContent) {
				return message.displayContent;
			}
		}
		return undefined;
	}

	private async _reply(chatId: number, markdown: string): Promise<void> {
		for (const chunk of splitForTelegram(markdownToTelegramHtml(markdown))) {
			await this._main.send({ chatId, text: chunk });
		}
	}

	override dispose(): void {
		if (this._windowId !== undefined) {
			void this._main.unregisterWindow(this._windowId);
		}
		super.dispose();
	}
}

const HELP_TEXT = [
	'Команды моста:',
	'• просто текст — поставить задачу агенту',
	'• /projects — какие окна открыты',
	'• /use <проект> — куда слать команды',
	'• /status — что сейчас происходит',
	'• /stop — остановить прогон',
].join('\n');

registerWorkbenchContribution2(VibeTelegramBridgeContribution.ID, VibeTelegramBridgeContribution, WorkbenchPhase.AfterRestored);

/**
 * Entering the bot token. Kept out of settings.json on purpose: that file syncs between machines
 * and lands in screenshots, while this token is full control of the bot.
 */
registerAction2(class VibeTelegramSetToken extends Action2 {
	constructor() {
		super({
			id: 'vibeide.telegram.setToken',
			title: localize2('vibeide.telegram.setToken', 'VibeIDE: Токен Telegram-бота'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const secrets = accessor.get(ISecretStorageService);
		const notifications = accessor.get(INotificationService);

		const token = await quickInput.input({
			password: true,
			ignoreFocusLost: true,
			prompt: localize('vibeide.telegram.tokenPrompt', "Токен бота от @BotFather. Пусто — удалить сохранённый токен и остановить мост."),
			placeHolder: '123456789:AA...',
		});
		if (token === undefined) {
			return;
		}
		if (!token.trim()) {
			await secrets.delete(VIBE_TELEGRAM_TOKEN_SECRET_KEY);
			notifications.info(localize('vibeide.telegram.tokenCleared', "Токен Telegram-бота удалён."));
			return;
		}
		await secrets.set(VIBE_TELEGRAM_TOKEN_SECRET_KEY, token.trim());
		notifications.info(localize('vibeide.telegram.tokenSaved', "Токен сохранён. Включите мост настройкой «vibeide.telegram.enabled»."));
	}
});

/**
 * Voice readiness for the settings panel. A command rather than a service: the panel needs one
 * number and one state, and the bridge already owns the channel to the main process.
 */
registerAction2(class VibeTelegramVoiceReadiness extends Action2 {
	constructor() {
		super({ id: 'vibeide.telegram.voiceReadiness', title: localize2('vibeide.telegram.voiceReadiness', 'VibeIDE: Состояние распознавания голосовых'), f1: false });
	}

	async run(accessor: ServicesAccessor): Promise<unknown> {
		const main = ProxyChannel.toService<IVibeTelegramMain>(accessor.get(IMainProcessService).getChannel(VIBE_TELEGRAM_CHANNEL));
		return main.getVoiceReadiness();
	}
});

/** Downloads the voice components ahead of time, so the first voice message is not a wait. */
registerAction2(class VibeTelegramDownloadVoice extends Action2 {
	constructor() {
		super({ id: 'vibeide.telegram.downloadVoice', title: localize2('vibeide.telegram.downloadVoice', 'VibeIDE: Скачать распознавание голосовых'), f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const main = ProxyChannel.toService<IVibeTelegramMain>(accessor.get(IMainProcessService).getChannel(VIBE_TELEGRAM_CHANNEL));
		const notifications = accessor.get(INotificationService);
		const before = await main.getVoiceReadiness();
		if (before.state === 'ready') {
			notifications.info(localize('vibeide.telegram.voiceAlready', "Распознавание голосовых уже готово."));
			return;
		}
		if (before.state === 'unsupported') {
			notifications.warn(before.detail);
			return;
		}
		notifications.info(localize('vibeide.telegram.voiceDownloading', "Качаю компоненты распознавания (~{0} МБ). Можно продолжать работать.", before.downloadMb));
		await main.prepareVoice();
		const after = await main.getVoiceReadiness();
		if (after.state === 'ready') {
			notifications.info(localize('vibeide.telegram.voiceReady', "Распознавание голосовых готово."));
		} else {
			notifications.error(localize('vibeide.telegram.voiceFailed', "Не удалось подготовить распознавание: {0}", after.detail));
		}
	}
});
