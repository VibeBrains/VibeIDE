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

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IChatThreadService } from '../../browser/chatThreadService.js';
import { vibeLog } from '../../common/vibeLog.js';
import { VIBE_COMMAND_CATEGORY } from '../../common/vibeCommandCategory.js';
import {
	IVibeHttpApiMain,
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
	private readonly _runListeners = this._register(new DisposableStore());

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@ISecretStorageService private readonly _secrets: ISecretStorageService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._main = ProxyChannel.toService<IVibeHttpApiMain>(mainProcessService.getChannel(VIBE_HTTP_API_CHANNEL));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VibeHttpApiConfigKeys.section)) { void this._sync(); }
		}));
		void this._sync();
	}

	/** Bring the listener in line with the settings. */
	private async _sync(): Promise<void> {
		this._runListeners.clear();
		const enabled = this._config.getValue<boolean>(VibeHttpApiConfigKeys.enabled) === true;
		if (!enabled) {
			await this._main.stop();
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
		const status = await this._main.start(port, token);
		if (!status.running) {
			this._notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.httpApi.startFailed', 'HTTP API не запустился: {0}', status.error ?? 'причина неизвестна'),
			});
			return;
		}
		this._runListeners.add(this._main.onRun(run => { void this._execute(run); }));
		vibeLog.info('HttpApi', `окно приняло запросы, порт ${status.port}`);
	}

	/**
	 * Run one request as a chat thread.
	 *
	 * `sessionId` IS the thread id — that is what makes step two of a CI pipeline talk to the same
	 * agent as step one. An unknown id starts a fresh thread instead of failing: the caller's
	 * session may simply have been cleared, and refusing would strand a pipeline with no way back.
	 */
	private async _execute(run: VibeHttpApiPendingRun): Promise<void> {
		let response: VibeHttpRunResponse;
		try {
			const requested = run.request.sessionId;
			const known = requested && this._chatThreadService.state.allThreads[requested] ? requested : undefined;
			// Ни переключения текущего треда, ни новой вкладки: запрос приходит, пока человек
			// работает в этом же окне, и раньше уводил у него разговор из-под рук посреди фразы.
			const threadId = known ?? this._chatThreadService.createBackgroundThread();
			// Внешний вызов работает в агентском режиме: в «Обзоре» и «Плане» инструменты правки
			// модели не выдаются, и задача из CI тихо превращалась в рассказ «такого инструмента
			// нет» (найдено живым смоуком). Режим ставится ТРЕДУ, а не окну — глобальная настройка
			// принадлежит человеку, и менять её за него ради своего прогона нельзя.
			this._chatThreadService.setThreadChatMode(threadId, 'agent');
			const streamed = this._chatThreadService.addUserMessageAndStreamResponse({
				userMessage: run.request.task,
				threadId,
			});
			if (run.request.wait) {
				await streamed;
				response = { sessionId: threadId, status: 'completed' };
			} else {
				// Not awaited on purpose: the caller asked to be told the run started. Failures
				// still surface — in the IDE, in the ledger, and in the daily digest.
				void streamed.catch(err => vibeLog.error('HttpApi', `прогон упал: ${err}`));
				response = { sessionId: threadId, status: 'started' };
			}
		} catch (err) {
			response = {
				sessionId: run.request.sessionId ?? '',
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
			};
		}
		await this._main.completeRun(run.requestId, response);
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
