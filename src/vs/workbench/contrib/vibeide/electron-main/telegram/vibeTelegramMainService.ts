/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { promises as fsPromises } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { tmpdir } from 'os';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { vibeLog } from '../../common/vibeLog.js';
import { createProxyDispatcher } from '../llmMessage/systemCAFetch.js';
import { decidePairing } from '../../common/telegram/telegramPairing.js';
import { VoiceProfileId } from '../../common/voice/vibeVoiceTypes.js';
import { VibeVoiceMainService } from '../voice/vibeVoiceMainService.js';
import { VibeVideoMainService } from '../video/vibeVideoMainService.js';
import {
	IVibeTelegramMain,
	VibeTelegramCommandForWindow,
	VibeTelegramDelivery,
	VibeTelegramApprovalDecision,
	VibeTelegramOutbound,
	VibeTelegramStatus,
	VibeTelegramTranscription,
	VibeTelegramVoiceReadiness,
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
	/** Code an unbound chat must send before the owner is even asked. */
	readonly pairingCode: string;
	/** Language profile for transcribing voice messages — same setting the dictation uses. */
	readonly voiceProfile: VoiceProfileId;
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

	private readonly _onDidAnswerApproval = this._register(new Emitter<{ token: string; decision: VibeTelegramApprovalDecision; chatId: number | undefined }>());
	readonly onDidAnswerApproval: Event<{ token: string; decision: VibeTelegramApprovalDecision; chatId: number | undefined }> = this._onDidAnswerApproval.event;

	private _status: VibeTelegramStatus = { state: 'off' };
	private _config: VibeTelegramRuntimeConfig = { token: undefined, proxyUrl: undefined, allowedChatIds: [], pairingCode: '', voiceProfile: 'ru' };
	/** When each unbound chat last made the IDE ask — throttles the confirmation prompt. */
	private readonly _lastPairingPromptAtMs = new Map<number, number>();
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
	/**
	 * Aborts the in-flight long poll. Without it a restart (any settings change) leaves the old
	 * 30-second `getUpdates` in the air while the new loop starts another one — two concurrent
	 * polls on one bot are exactly what Telegram answers with 409 Conflict.
	 */
	private _pollAbort: AbortController | undefined;

	constructor(
		private readonly _log: ILogService,
		// Voice re-uses what other features already downloaded: ffmpeg ships with the video tools
		// (`/watch`), the offline model with local speech. Writing a second decoder here would
		// mean a second download of the same binary.
		private readonly _voice: VibeVoiceMainService,
		private readonly _video: VibeVideoMainService,
	) {
		super();
	}

	/** Language profile of the offline recogniser, pushed from the window with the settings. */
	private _voiceProfile: VoiceProfileId = 'ru';


	/** Pushed from the window side, which owns configuration and SecretStorage. */
	async setConfig(config: VibeTelegramRuntimeConfig): Promise<void> {
		this._config = config;
		this._voiceProfile = config.voiceProfile;
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
		this._pollAbort?.abort();
		this._pollAbort = undefined;
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
				], [
					{ text: '✏️ Поправить', callback_data: `ed:${message.approval.token}` },
				]],
			};
		}
		if (message.editMessageId !== undefined) {
			body.message_id = message.editMessageId;
		}

		const method = message.editMessageId !== undefined ? 'editMessageText' : 'sendMessage';
		const res = await this._call<{ message_id?: number }>(method, body);
		if (!res.ok) {
			// Delivery failures were invisible before: the bridge looked alive while the user's
			// phone stayed silent, which is the hardest possible symptom to diagnose.
			vibeLog.warn('Telegram', `${method} to chat ${message.chatId} failed: ${res.error}`);
			return { ok: false, error: res.error };
		}
		vibeLog.info('Telegram', `${method} to chat ${message.chatId} ok (${message.text.length} chars)`);
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

	/** Whether voice input can run right now, and what is still missing. */
	async getVoiceReadiness(): Promise<VibeTelegramVoiceReadiness> {
		const tools = this._video.getToolsState();
		const model = this._voice.getBatchState(this._voiceProfile);
		if (tools.state === 'missing' && tools.downloadBytes === 0) {
			// The video tools report zero bytes on platforms they have no build for; voice cannot
			// work there at all, and saying "download" would send the user in circles.
			return { state: 'unsupported', downloadMb: 0, detail: 'Распознавание речи недоступно на этой платформе.' };
		}
		if (tools.state === 'downloading' || model.state === 'downloading') {
			return { state: 'downloading', downloadMb: 0, detail: 'Компоненты распознавания скачиваются…' };
		}
		if (tools.state === 'ready' && model.state === 'ready') {
			return { state: 'ready', downloadMb: 0, detail: 'Голосовые сообщения распознаются локально, на этом компьютере.' };
		}
		const bytes = (tools.state === 'ready' ? 0 : tools.downloadBytes) + (model.state === 'ready' ? 0 : model.downloadBytes);
		const mb = Math.max(1, Math.round(bytes / (1024 * 1024)));
		return {
			state: 'needsDownload',
			downloadMb: mb,
			detail: `Для голосовых нужно скачать ~${mb} МБ (ffmpeg и офлайн-модель распознавания). Скачается автоматически при первом голосовом.`,
		};
	}

	/** Downloads the voice components without waiting for a first voice message. */
	async prepareVoice(): Promise<void> {
		const readiness = await this.getVoiceReadiness();
		if (readiness.state === 'ready' || readiness.state === 'unsupported') {
			return;
		}
		await this._video.ensureTools();
		await this._voice.ensureBatchModel(this._voiceProfile);
	}

	/**
	 * Voice message → text, entirely on this machine. Reuses the `/watch` pipeline: the file is
	 * handed to the video service as a local media path, which decodes it with ffmpeg and runs
	 * the offline recogniser — no second decoder, no second copy of the binary.
	 */
	async transcribeVoice(fileId: string): Promise<VibeTelegramTranscription> {
		const readiness = await this.getVoiceReadiness();
		if (readiness.state === 'unsupported') {
			return { ok: false, reason: readiness.detail };
		}

		let oggPath: string | undefined;
		const requestId = `telegram-voice-${fileId.slice(-12)}`;
		try {
			if (readiness.state !== 'ready') {
				vibeLog.info('Telegram', `voice components missing (~${readiness.downloadMb} MB) — downloading`);
				await this._video.ensureTools();
				await this._voice.ensureBatchModel(this._voiceProfile);
			}

			const audio = await this.downloadVoice(fileId);
			if (!audio) {
				return { ok: false, reason: 'Не удалось скачать голосовое сообщение из Telegram.' };
			}
			oggPath = join(tmpdir(), `${requestId}.oga`);
			await fsPromises.writeFile(oggPath, audio.buffer);

			await this._video.analyze({ requestId, input: oggPath });
			const segments = await this._video.transcribe(requestId, this._voiceProfile);
			const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
			if (!text) {
				return { ok: false, reason: 'В голосовом сообщении не разобрано ни слова — попробуйте ещё раз или напишите текстом.' };
			}
			vibeLog.info('Telegram', `voice transcribed: ${text.length} chars`);
			return { ok: true, text };
		} catch (e) {
			vibeLog.error('Telegram', `voice transcription failed: ${(e as Error).message}`);
			return { ok: false, reason: `Не смог распознать голосовое: ${(e as Error).message}` };
		} finally {
			// Both cleanups are best-effort: a leftover temp file must never fail the message.
			try { await this._video.cleanup(requestId); } catch { /* already gone */ }
			if (oggPath) {
				try { await fsPromises.unlink(oggPath); } catch { /* already gone */ }
			}
		}
	}

	// --- polling ---------------------------------------------------------------------------

	private async _pollLoop(generation: number): Promise<void> {
		while (this._polling && generation === this._generation) {
			this._pollAbort = new AbortController();
			const res = await this._call<TelegramUpdate[]>('getUpdates', {
				offset: this._offset,
				timeout: POLL_TIMEOUT_S,
				allowed_updates: ['message', 'callback_query'],
			}, (POLL_TIMEOUT_S + 10) * 1000, this._pollAbort.signal);

			if (generation !== this._generation) {
				return;
			}
			if (!res.ok && generation !== this._generation) {
				// Aborted by a restart — expected, and reporting it would flash a false error.
				return;
			}
			if (!res.ok) {
				// Report but keep trying: a laptop that slept or a dropped VPN must heal by itself
				// rather than leave a silent bridge that looks identical to "no messages".
				// Logged as well as surfaced: a failing poll that only changes a status field is
				// indistinguishable from silence when reading the log afterwards.
				vibeLog.warn('Telegram', `getUpdates failed: ${res.error}`);
				this._setStatus({ state: 'error', error: res.error });
				await timeout(POLL_ERROR_BACKOFF_MS);
				if (this._polling && generation === this._generation) {
					this._setStatus({ state: 'listening', botUsername: this._status.botUsername });
				}
				continue;
			}

			const updates = res.result ?? [];
			if (updates.length) {
				vibeLog.info('Telegram', `got ${updates.length} update(s)`);
			}
			for (const update of updates) {
				this._offset = Math.max(this._offset, update.update_id + 1);
				this._handleUpdate(update);
			}
		}
	}

	private _handleUpdate(update: TelegramUpdate): void {
		if (update.callback_query) {
			const data = update.callback_query.data ?? '';
			const chatId = update.callback_query.message?.chat?.id;
			// Telegram spins the button until the press is acknowledged, so answer first — the
			// owner must see that the tap landed even while the IDE is still acting on it.
			void this._call('answerCallbackQuery', { callback_query_id: update.callback_query.id });
			if (chatId === undefined || !this._config.allowedChatIds.includes(chatId)) {
				// A press is an inbound message like any other: a chat that lost its binding (or
				// never had one) must not steer a run through an old keyboard.
				vibeLog.info('Telegram', `callback from chat ${chatId ?? 'unknown'} outside the allow-list — ignored`);
				return;
			}
			const decision = data.startsWith('ok:') ? 'approve' : data.startsWith('ed:') ? 'amend' : 'reject';
			const token = data.slice(3);
			if (token) {
				this._onDidAnswerApproval.fire({ token, decision, chatId });
			}
			return;
		}

		const message = update.message;
		const chatId = message?.chat?.id;
		if (!message || chatId === undefined) {
			vibeLog.info('Telegram', `update ${update.update_id} carried no usable message — skipped`);
			return;
		}

		if (!this._config.allowedChatIds.includes(chatId)) {
			const decision = decidePairing({
				text: message.text ?? '',
				chatType: message.chat?.type,
				expectedCode: this._config.pairingCode,
				lastPromptAtMs: this._lastPairingPromptAtMs.get(chatId),
				nowMs: Date.now(),
			});
			if (decision.kind === 'ignore') {
				// Silent on purpose: any reply would tell a stranger the bot is live and let them
				// probe codes. The owner is not disturbed either.
				vibeLog.info('Telegram', `unbound chat ${chatId} without a valid pairing code — ignored`);
				return;
			}
			if (decision.kind === 'reject') {
				void this.send({ chatId, text: decision.reply });
				return;
			}
			const from = [message.from?.first_name, message.from?.username && `@${message.from.username}`]
				.filter(Boolean).join(' ') || undefined;
			this._lastPairingPromptAtMs.set(chatId, Date.now());
			vibeLog.info('Telegram', `unbound chat ${chatId} sent a valid pairing code — asking the owner`);
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
		vibeLog.info('Telegram', `chat ${chatId} → window ${windowId}: ${text.slice(0, 60)}`);
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

	private _fetch(url: string, body: unknown, timeoutMs = 30000, abortSignal?: AbortSignal): Promise<Response> {
		const signal = abortSignal
			? AbortSignal.any([abortSignal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		const init: RequestInit & { dispatcher?: unknown } = {
			method: body === undefined ? 'GET' : 'POST',
			signal,
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
	private async _call<T>(method: string, body: unknown, timeoutMs?: number, abortSignal?: AbortSignal): Promise<{ ok: boolean; result?: T; error?: string }> {
		if (!this._config.token) {
			return { ok: false, error: 'Токен бота не задан.' };
		}
		try {
			const response = await this._fetch(`https://api.telegram.org/bot${this._config.token}/${method}`, body, timeoutMs, abortSignal);
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
		readonly chat?: { readonly id?: number; readonly type?: string };
		readonly text?: string;
		readonly voice?: { readonly file_id: string };
		readonly from?: { readonly first_name?: string; readonly username?: string };
	};
	readonly callback_query?: {
		readonly id: string;
		readonly data?: string;
		readonly message?: { readonly chat?: { readonly id?: number } };
	};
}
