/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { vibeLog } from '../../common/vibeLog.js';
import { createProxyDispatcher } from '../llmMessage/systemCAFetch.js';
import {
	IVibeTelegramMain,
	VibeTelegramCommandForWindow,
	VibeTelegramDelivery,
	VibeTelegramOutbound,
	VibeTelegramStatus,
	VibeTelegramWindow,
	VSBufferLike,
} from '../../common/telegram/vibeTelegramTypes.js';

/** Long-poll window asked of Telegram, in seconds. */
const POLL_TIMEOUT_S = 30;

/** Backoff after a failed poll, so a dead network does not spin the CPU. */
const POLL_ERROR_BACKOFF_MS = 5000;

/** What the poller needs from settings; the window side reads the configuration and pushes it here. */
export interface VibeTelegramRuntimeConfig {
	readonly token: string | undefined;
	readonly proxyUrl: string | undefined;
	readonly allowedChatIds: readonly number[];
}

/**
 * The Telegram poller. Lives in the main process on purpose: there is exactly one per
 * application, so two open windows cannot both call `getUpdates` — Telegram answers the second
 * caller with 409 Conflict and the bridge would go silent with no visible cause.
 *
 * Only bound chats are acted on. An unknown chat produces a binding request that the IDE shows
 * to the owner; until they agree, the message is dropped. Anything else would hand tool
 * execution on a personal machine to whoever guessed the bot's name.
 */
export class VibeTelegramMainService extends Disposable implements IVibeTelegramMain {

	private readonly _onDidChangeStatus = this._register(new Emitter<VibeTelegramStatus>());
	readonly onDidChangeStatus: Event<VibeTelegramStatus> = this._onDidChangeStatus.event;

	private readonly _onDidReceiveCommand = this._register(new Emitter<VibeTelegramCommandForWindow & { windowId: number }>());
	readonly onDidReceiveCommand: Event<VibeTelegramCommandForWindow & { windowId: number }> = this._onDidReceiveCommand.event;

	private readonly _onDidRequestBinding = this._register(new Emitter<{ chatId: number; from: string | undefined }>());
	readonly onDidRequestBinding: Event<{ chatId: number; from: string | undefined }> = this._onDidRequestBinding.event;

	private readonly _onDidAnswerApproval = this._register(new Emitter<{ token: string; approved: boolean }>());
	readonly onDidAnswerApproval: Event<{ token: string; approved: boolean }> = this._onDidAnswerApproval.event;

	private _status: VibeTelegramStatus = { state: 'off' };
	private _config: VibeTelegramRuntimeConfig = { token: undefined, proxyUrl: undefined, allowedChatIds: [] };
	/** Windows that announced themselves, newest registration last. */
	private readonly _windows = new Map<number, VibeTelegramWindow>();
	/** Which window each chat is currently talking to (`/use` switches it). */
	private readonly _chatTarget = new Map<number, number>();
	/** Telegram update cursor; only updates newer than this are delivered. */
	private _offset = 0;
	private _polling = false;
	/** Set while a poll loop is alive; cleared to make the loop exit. */
	private _generation = 0;
	private _dispatcher: unknown;
	private _dispatcherProxyUrl: string | undefined;

	constructor(
		private readonly _log: ILogService,
	) {
		super();
	}

	/** Pushed from the window side, which owns configuration and SecretStorage. */
	async setConfig(config: VibeTelegramRuntimeConfig): Promise<void> {
		this._config = config;
	}

	async getStatus(): Promise<VibeTelegramStatus> {
		return this._status;
	}

	async registerWindow(window: VibeTelegramWindow): Promise<void> {
		this._windows.set(window.windowId, window);
		vibeLog.info('Telegram', `window ${window.windowId} registered (project: ${window.projectName ?? 'нет'})`);
	}

	async unregisterWindow(windowId: number): Promise<void> {
		this._windows.delete(windowId);
		for (const [chatId, target] of this._chatTarget) {
			if (target === windowId) {
				this._chatTarget.delete(chatId);
			}
		}
	}

	/** Windows currently able to serve commands — the answer to `/projects`. */
	async listWindows(): Promise<readonly VibeTelegramWindow[]> {
		return [...this._windows.values()];
	}

	/** Points a chat at a window; subsequent commands from that chat go there. */
	async bindChatToWindow(chatId: number, windowId: number): Promise<void> {
		this._chatTarget.set(chatId, windowId);
	}

	async start(): Promise<VibeTelegramStatus> {
		await this.stop();
		if (!this._config.token) {
			return this._setStatus({ state: 'off' });
		}

		this._setStatus({ state: 'connecting' });
		const me = await this._call<{ username?: string }>('getMe', {});
		if (!me.ok) {
			return this._setStatus({ state: 'error', error: me.error });
		}

		const status = this._setStatus({ state: 'listening', botUsername: me.result?.username ? `@${me.result.username}` : undefined });
		this._polling = true;
		const generation = ++this._generation;
		void this._pollLoop(generation);
		return status;
	}

	async stop(): Promise<void> {
		this._polling = false;
		this._generation += 1;
		if (this._status.state !== 'off') {
			this._setStatus({ state: 'off' });
		}
	}

	async send(message: VibeTelegramOutbound): Promise<VibeTelegramDelivery> {
		const body: Record<string, unknown> = {
			chat_id: message.chatId,
			text: message.text,
			parse_mode: 'HTML',
			// Previews of links found in an answer add noise and can leak an internal URL to
			// Telegram's fetcher; the text itself stays clickable.
			disable_web_page_preview: true,
		};
		if (message.approval) {
			body.reply_markup = {
				inline_keyboard: [[
					{ text: '✅ Разрешить', callback_data: `ok:${message.approval.token}` },
					{ text: '⛔️ Отклонить', callback_data: `no:${message.approval.token}` },
				]],
			};
		}
		if (message.editMessageId !== undefined) {
			body.message_id = message.editMessageId;
		}

		const method = message.editMessageId !== undefined ? 'editMessageText' : 'sendMessage';
		const res = await this._call<{ message_id?: number }>(method, body);
		if (!res.ok) {
			return { ok: false, error: res.error };
		}
		return { ok: true, messageId: res.result?.message_id };
	}

	async downloadVoice(fileId: string): Promise<VSBufferLike | undefined> {
		const meta = await this._call<{ file_path?: string }>('getFile', { file_id: fileId });
		if (!meta.ok || !meta.result?.file_path) {
			return undefined;
		}
		try {
			const response = await this._fetch(`https://api.telegram.org/file/bot${this._config.token}/${meta.result.file_path}`, undefined);
			if (!response.ok) {
				return undefined;
			}
			return { buffer: new Uint8Array(await response.arrayBuffer()) };
		} catch (e) {
			vibeLog.error('Telegram', `voice download failed: ${(e as Error).message}`);
			return undefined;
		}
	}

	// --- polling ---------------------------------------------------------------------------

	private async _pollLoop(generation: number): Promise<void> {
		while (this._polling && generation === this._generation) {
			const res = await this._call<TelegramUpdate[]>('getUpdates', {
				offset: this._offset,
				timeout: POLL_TIMEOUT_S,
				allowed_updates: ['message', 'callback_query'],
			}, (POLL_TIMEOUT_S + 10) * 1000);

			if (generation !== this._generation) {
				return;
			}
			if (!res.ok) {
				// Report but keep trying: a laptop that slept or a dropped VPN must heal by itself
				// rather than leave a silent bridge that looks identical to "no messages".
				this._setStatus({ state: 'error', error: res.error });
				await timeout(POLL_ERROR_BACKOFF_MS);
				if (this._polling && generation === this._generation) {
					this._setStatus({ state: 'listening', botUsername: this._status.botUsername });
				}
				continue;
			}

			for (const update of res.result ?? []) {
				this._offset = Math.max(this._offset, update.update_id + 1);
				this._handleUpdate(update);
			}
		}
	}

	private _handleUpdate(update: TelegramUpdate): void {
		if (update.callback_query) {
			const data = update.callback_query.data ?? '';
			const approved = data.startsWith('ok:');
			const token = data.slice(3);
			if (token) {
				this._onDidAnswerApproval.fire({ token, approved });
			}
			return;
		}

		const message = update.message;
		const chatId = message?.chat?.id;
		if (!message || chatId === undefined) {
			return;
		}

		if (!this._config.allowedChatIds.includes(chatId)) {
			const from = [message.from?.first_name, message.from?.username && `@${message.from.username}`]
				.filter(Boolean).join(' ') || undefined;
			vibeLog.info('Telegram', `unbound chat ${chatId} wrote — asking the owner`);
			this._onDidRequestBinding.fire({ chatId, from });
			return;
		}

		const text = message.text ?? '';
		const voiceFileId = message.voice?.file_id;
		if (!text && !voiceFileId) {
			return;
		}

		const windowId = this._resolveTarget(chatId);
		if (windowId === undefined) {
			void this.send({ chatId, text: 'Нет открытых окон VibeIDE — открой проект в IDE и повтори.' });
			return;
		}
		this._onDidReceiveCommand.fire({ chatId, text, voiceFileId, windowId });
	}

	/**
	 * Which window serves this chat: the one it was pointed at, else the only one, else the
	 * most recently registered. Guessing between several windows is better than refusing —
	 * `/use` exists to correct it, and `/status` says which one answered.
	 */
	private _resolveTarget(chatId: number): number | undefined {
		const bound = this._chatTarget.get(chatId);
		if (bound !== undefined && this._windows.has(bound)) {
			return bound;
		}
		const ids = [...this._windows.keys()];
		return ids.length ? ids[ids.length - 1] : undefined;
	}

	// --- transport -------------------------------------------------------------------------

	private _setStatus(status: VibeTelegramStatus): VibeTelegramStatus {
		this._status = status;
		this._onDidChangeStatus.fire(status);
		return status;
	}

	/**
	 * Connection pool for the bridge, rebuilt only when the proxy setting changes. Building one
	 * per request would leak a socket pool on every poll — and polling never stops.
	 */
	private _dispatcherFor(proxyUrl: string | undefined): unknown {
		if (!this._dispatcher || this._dispatcherProxyUrl !== proxyUrl) {
			this._dispatcherProxyUrl = proxyUrl;
			this._dispatcher = createProxyDispatcher(proxyUrl, 'telegram');
		}
		return this._dispatcher;
	}

	private _fetch(url: string, body: unknown, timeoutMs = 30000): Promise<Response> {
		const init: RequestInit & { dispatcher?: unknown } = {
			method: body === undefined ? 'GET' : 'POST',
			signal: AbortSignal.timeout(timeoutMs),
			// Own dispatcher, not the LLM one: `api.telegram.org` and the model APIs are blocked
			// in different places, and system CAs must still be honoured (plain undici ignores both
			// the system store and the proxy — that already cost us the models.dev outage).
			dispatcher: this._dispatcherFor(this._config.proxyUrl),
		};
		if (body !== undefined) {
			init.headers = { 'Content-Type': 'application/json' };
			init.body = JSON.stringify(body);
		}
		return fetch(url, init as RequestInit);
	}

	/** One Bot API call. Never throws: the caller gets a Russian reason instead. */
	private async _call<T>(method: string, body: unknown, timeoutMs?: number): Promise<{ ok: boolean; result?: T; error?: string }> {
		if (!this._config.token) {
			return { ok: false, error: 'Токен бота не задан.' };
		}
		try {
			const response = await this._fetch(`https://api.telegram.org/bot${this._config.token}/${method}`, body, timeoutMs);
			const payload = await response.json() as { ok: boolean; result?: T; description?: string; error_code?: number };
			if (!payload.ok) {
				// 409 means another poller holds this bot — the one case where the cause is not
				// obvious from the text, so it is named outright.
				const detail = payload.error_code === 409
					? 'этот бот уже опрашивается другим приложением (закрой второй экземпляр или отключи webhook)'
					: (payload.description ?? 'неизвестная ошибка');
				return { ok: false, error: `Telegram: ${detail}` };
			}
			return { ok: true, result: payload.result };
		} catch (e) {
			const message = (e as Error).name === 'TimeoutError'
				? 'нет ответа от api.telegram.org (таймаут). Если Telegram заблокирован — укажи прокси в настройках моста.'
				: (e as Error).message;
			this._log.trace(`[Telegram] ${method} failed: ${message}`);
			return { ok: false, error: `Сеть: ${message}` };
		}
	}
}

function timeout(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Bot API shapes we actually read ---------------------------------------------------------

interface TelegramUpdate {
	readonly update_id: number;
	readonly message?: {
		readonly chat?: { readonly id?: number };
		readonly text?: string;
		readonly voice?: { readonly file_id: string };
		readonly from?: { readonly first_name?: string; readonly username?: string };
	};
	readonly callback_query?: { readonly data?: string };
}
