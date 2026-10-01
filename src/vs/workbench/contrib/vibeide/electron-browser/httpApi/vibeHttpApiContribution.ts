/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Incoming HTTP API — the window side.
 *
 * The main process owns the socket; this owns the agent. A request arrives as an event, becomes a
 * chat thread, and the answer goes back over the same channel.
 *
 * Why the token lives in SecretStorage and not in settings: settings sync to other machines and
 * show up in screen shares, and this token is worth a shell on the owner's computer. It is shown
 * exactly once, when the user asks for it.
 */

import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableMap, toDisposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { watchChatRun } from '../../browser/chatRunWatch.js';
import { IChatThreadService } from '../../browser/chatThreadService.js';
import { vibeLog } from '../../common/vibeLog.js';
import { VIBE_COMMAND_CATEGORY } from '../../common/vibeCommandCategory.js';
import {
	IVibeHttpApiMain,
	MAX_ANSWER_CHARS,
	VIBE_HTTP_API_CHANNEL,
	VibeHttpApiConfigKeys,
	VibeHttpApiPendingRun,
	VibeHttpRunResponse,
} from '../../common/httpApi/vibeHttpApiTypes.js';

/** SecretStorage key of the API token. */
const TOKEN_SECRET_KEY = 'vibeide.httpApi.token';

export class VibeHttpApiContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeHttpApi';

	private readonly _main: IVibeHttpApiMain;
	/** New on every load of the window, so the main process can tell this instance from the one before a reload */
	private readonly _instanceId = generateUuid();
	/**
	 * The watch over each session's current run
	 * A new request on the same session replaces the entry, which cancels the old watch:
	 * The new send aborts the old run, and its late word must not overwrite the new run's status
	 */
	private readonly _watches = this._register(new DisposableMap<string>());

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@ISecretStorageService private readonly _secrets: ISecretStorageService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@INotificationService private readonly _notifications: INotificationService,
		@INativeHostService private readonly _nativeHost: INativeHostService,
	) {
		super();
		this._main = ProxyChannel.toService<IVibeHttpApiMain>(mainProcessService.getChannel(VIBE_HTTP_API_CHANNEL));
		// Every window hears every request; only the instance the main process handed it to runs it
		this._register(this._main.onRun(run => {
			if (run.instanceId === this._instanceId) { void this._execute(run); }
		}));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VibeHttpApiConfigKeys.section)) { void this._sync(); }
		}));
		void this._sync();
	}

	/**
	 * Offer this window to serve the API, or withdraw it
	 * Only one window serves at a time; the others stand by and take over when it reloads, closes or turns the API off
	 */
	private async _sync(): Promise<void> {
		const enabled = this._config.getValue<boolean>(VibeHttpApiConfigKeys.enabled) === true;
		if (!enabled) {
			await this._main.unregister(this._instanceId);
			return;
		}
		let token = await this._secrets.get(TOKEN_SECRET_KEY);
		if (!token) {
			// First enable: mint a token rather than starting without one. A listener that accepts
			// anything local is a backdoor with a settings page.
			token = await this._main.generateToken();
			await this._secrets.set(TOKEN_SECRET_KEY, token);
		}
		const port = this._config.getValue<number>(VibeHttpApiConfigKeys.port) ?? 0;
		const result = await this._main.register({ windowId: this._nativeHost.windowId, instanceId: this._instanceId, port, token });
		if (!result.owner) {
			vibeLog.info('HttpApi', 'запросы обслуживает другое окно, это окно в резерве');
			return;
		}
		if (!result.running) {
			this._notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.httpApi.startFailed', 'HTTP API не запустился: {0}', result.error ?? 'причина неизвестна'),
			});
			return;
		}
		vibeLog.info('HttpApi', `окно приняло запросы, порт ${result.port}`);
	}

	/**
	 * Run one request as a chat thread.
	 *
	 * `sessionId` IS the thread id — that is what makes step two of a CI pipeline talk to the same
	 * agent as step one. An unknown id starts a fresh thread instead of failing: the caller's
	 * session may simply have been cleared, and refusing would strand a pipeline with no way back.
	 *
	 * The run is followed to its end whether or not the caller waits:
	 * Where it stands is reported for `GET /run/<sessionId>`
	 * A waiting caller is answered at the end, or with 202 at a request for approval — a person may take hours
	 */
	private async _execute(run: VibeHttpApiPendingRun): Promise<void> {
		let threadId: string | undefined;
		let answered = false;
		const answer = async (response: VibeHttpRunResponse) => {
			if (answered) { return; }
			answered = true;
			await this._main.completeRun(run.requestId, response);
		};
		const report = (response: VibeHttpRunResponse) => this._main.reportRun({ ...response, requestId: run.requestId, instanceId: this._instanceId });
		const watch = new CancellationTokenSource();
		const watchEntry = toDisposable(() => watch.dispose(true));
		try {
			const requested = run.request.sessionId;
			const known = requested && this._chatThreadService.state.allThreads[requested] ? requested : undefined;
			// Ни переключения текущего треда, ни новой вкладки: запрос приходит, пока человек
			// работает в этом же окне, и раньше уводил у него разговор из-под рук посреди фразы.
			const sessionId = known ?? this._chatThreadService.createBackgroundThread();
			threadId = sessionId;
			this._watches.set(sessionId, watchEntry);
			// Внешний вызов работает в агентском режиме: в «Обзоре» и «Плане» инструменты правки
			// модели не выдаются, и задача из CI тихо превращалась в рассказ «такого инструмента
			// нет» (найдено живым смоуком). Режим ставится ТРЕДУ, а не окну — глобальная настройка
			// принадлежит человеку, и менять её за него ради своего прогона нельзя.
			this._chatThreadService.setThreadChatMode(sessionId, 'agent');
			// Recorded before the run starts, so a caller polling right after `started` finds the session
			await report({ sessionId, status: 'running' });
			const sinceMs = Date.now();
			// Resolves once the run is launched, not when it ends; the watch below decides the end
			await this._chatThreadService.addUserMessageAndStreamResponse({ userMessage: run.request.task, threadId: sessionId });
			if (!run.request.wait) {
				await answer({ sessionId, status: 'started' });
			}
			const outcome = await watchChatRun(this._chatThreadService, sessionId, {
				sinceMs,
				answerCap: MAX_ANSWER_CHARS,
				token: watch.token,
				onPhase: async phase => {
					await report({ sessionId, status: phase });
					if (phase === 'awaiting_approval' && run.request.wait) {
						await answer({ sessionId, status: 'awaiting_approval' });
					}
				},
			});
			if (!outcome) {
				// Superseded by a newer request on this session, or the window is going away
				// The newer run reports for the session from here on; only a caller still waiting here needs a word
				await answer({ sessionId, status: 'aborted', error: localize('vibeide.httpApi.superseded', 'Прогон прерван: сессию продолжил следующий запрос или окно IDE закрывается') });
				return;
			}
			const response: VibeHttpRunResponse = {
				sessionId,
				status: outcome.phase,
				...(outcome.answer ? { answer: outcome.answer.text } : {}),
				...(outcome.answer?.truncated ? { answerTruncated: true } : {}),
				...(outcome.error !== undefined ? { error: outcome.error } : {}),
			};
			await report(response);
			await answer(response);
		} catch (err) {
			const response: VibeHttpRunResponse = {
				sessionId: threadId ?? run.request.sessionId ?? '',
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
			};
			if (threadId && !watch.token.isCancellationRequested) {
				await report(response).catch(() => { /* the answer below still carries the failure */ });
			}
			await answer(response);
		} finally {
			// Drop the entry only if it is still this watch; a newer request may already have taken the session
			if (threadId && this._watches.get(threadId) === watchEntry) {
				this._watches.deleteAndDispose(threadId);
			} else {
				watch.dispose();
			}
		}
	}

	/** The token, minted on demand. Shown once — we never log it. */
	async revealToken(): Promise<string | undefined> {
		let token = await this._secrets.get(TOKEN_SECRET_KEY);
		if (!token) {
			token = await this._main.generateToken();
			await this._secrets.set(TOKEN_SECRET_KEY, token);
		}
		return token;
	}

	async rotateToken(): Promise<string> {
		const token = await this._main.generateToken();
		await this._secrets.set(TOKEN_SECRET_KEY, token);
		await this._sync();
		return token;
	}

	async status(): Promise<{ running: boolean; port?: number; error?: string }> {
		return this._main.getStatus();
	}

	override dispose(): void {
		// Best effort: a reload may cut the channel first, and the main process retires the window on its own then
		void this._main.unregister(this._instanceId).catch(() => { /* the window is going away either way */ });
		super.dispose();
	}
}

registerWorkbenchContribution2(VibeHttpApiContribution.ID, VibeHttpApiContribution, WorkbenchPhase.AfterRestored);

registerAction2(class VibeHttpApiShowToken extends Action2 {
	constructor() {
		super({
			id: 'vibeide.httpApi.showToken',
			title: localize2('vibeide.httpApi.showToken', 'Показать токен HTTP API'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const secrets = accessor.get(ISecretStorageService);
		const dialogs = accessor.get(IDialogService);
		const config = accessor.get(IConfigurationService);
		const token = await secrets.get(TOKEN_SECRET_KEY);
		if (!token) {
			await dialogs.info(
				localize('vibeide.httpApi.noToken', 'Токен ещё не создан'),
				localize('vibeide.httpApi.noTokenDetail', 'Включите настройку `{0}` — токен создастся при запуске.', VibeHttpApiConfigKeys.enabled),
			);
			return;
		}
		const port = config.getValue<number>(VibeHttpApiConfigKeys.port) ?? 0;
		// The curl line is built OUTSIDE the localized string and passed in as a parameter. Its JSON
		// body contains braces, and the message formatter treats those as placeholders: doubling
		// them to escape does not survive the round trip — the dialog showed a literal `{{"task"…}}`,
		// i.e. a command that fails when pasted. Verified live, which is the only way it surfaced.
		const example = `curl -H "Authorization: Bearer <токен>" -H "Content-Type: application/json" -d '{"task":"собери проект"}' http://127.0.0.1:${port || '<порт>'}/run`;
		await dialogs.info(
			localize('vibeide.httpApi.tokenTitle', 'Токен HTTP API'),
			localize(
				'vibeide.httpApi.tokenDetail',
				'{0}\n\nПример вызова:\n{1}\n\nОтвет содержит sessionId — передайте его следующим вызовом, чтобы продолжить ту же сессию.',
				token,
				example,
			),
		);
	}
});
