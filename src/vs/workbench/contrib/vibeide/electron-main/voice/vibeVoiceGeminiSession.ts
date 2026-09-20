/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as WsTypes from 'ws';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { VoiceProfileId, VoiceSessionEvent } from '../../common/voice/vibeVoiceTypes.js';
import { buildGeminiAudioMessage, buildGeminiAudioStreamEnd, buildGeminiTranscribeSetup, GEMINI_TRANSCRIBE_RENEW_MS, GeminiTranscribeOptions, geminiLiveUrl, parseGeminiLiveMessage } from '../../common/voice/vibeVoiceGeminiLive.js';

/** How long a graceful stop waits for the last transcript after the end of the audio stream. */
const STOP_GRACE_MS = 3000;
/** Chunks kept while the connection is being set up or replaced; beyond this the oldest are dropped. */
const MAX_QUEUED_CHUNKS = 400;

/**
 * One cloud dictation session on Gemini Live Transcribe.
 *
 * Emits the same `VoiceSessionEvent`s as the local worker, so the renderer does not know which engine
 * is behind it. A Live connection is time-limited: the session opens a replacement, queues audio until
 * the new one is set up, then drops the old one — a dictation longer than one connection keeps going.
 *
 * The replacement is opened on a timer, a minute before the vendor's 10-minute limit, and `goAway` only
 * brings it forward when the server bothers to send one. The other way round — waiting for `goAway` —
 * is waiting for a signal this model's page never promises: the socket closes mid-word and the user
 * sees «connection closed by the server» after ten minutes of dictation.
 */
export class GeminiTranscribeSession {

	private socket: WsTypes.WebSocket | undefined;
	private retiring: WsTypes.WebSocket | undefined;
	private ready = false;
	private announcedReady = false;
	private ending = false;
	private finished = false;
	private stopTimer: ReturnType<typeof setTimeout> | undefined;
	private renewTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly queued: string[] = [];

	constructor(
		private readonly sessionId: string,
		private readonly profileId: VoiceProfileId,
		private readonly apiKey: string,
		private readonly options: GeminiTranscribeOptions,
		private readonly logService: ILogService,
		private readonly emit: (event: VoiceSessionEvent) => void,
	) { }

	async start(): Promise<void> {
		try {
			await this.connect();
		} catch (error) {
			this.fail(error instanceof Error ? error.message : String(error));
		}
	}

	pushAudio(pcm: Uint8Array): void {
		if (this.ending || this.finished) {
			return;
		}
		const message = JSON.stringify(buildGeminiAudioMessage(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')));
		if (this.ready && this.socket?.readyState === this.socket?.OPEN) {
			this.socket?.send(message);
			return;
		}
		this.queued.push(message);
		if (this.queued.length > MAX_QUEUED_CHUNKS) {
			this.queued.shift();
		}
	}

	/** Graceful stop: end the audio stream, give the service a moment for the last transcript, then close. */
	stop(): void {
		if (this.ending || this.finished) {
			return;
		}
		this.ending = true;
		this.flushQueue();
		if (this.socket?.readyState === this.socket?.OPEN) {
			this.socket?.send(JSON.stringify(buildGeminiAudioStreamEnd()));
		}
		this.stopTimer = setTimeout(() => this.closeAll(), STOP_GRACE_MS);
	}

	/** Discard: close now, no last transcript. */
	cancel(): void {
		if (this.finished) {
			return;
		}
		this.ending = true;
		this.closeAll();
	}

	/** Open the replacement connection before the stream limit ends this one. */
	private scheduleRenew(): void {
		if (this.renewTimer) {
			clearTimeout(this.renewTimer);
		}
		this.renewTimer = setTimeout(() => {
			if (this.ending || this.finished) {
				return;
			}
			this.logService.info(`[vibeVoice] cloud session ${this.sessionId}: stream limit is near, opening a replacement`);
			this.connect().catch(error => this.fail(error instanceof Error ? error.message : String(error)));
		}, GEMINI_TRANSCRIBE_RENEW_MS);
	}

	private async connect(): Promise<void> {
		this.scheduleRenew();
		const { WebSocket } = await import('ws');
		const socket = new WebSocket(geminiLiveUrl(this.apiKey));
		this.retiring = this.socket;
		this.socket = socket;
		this.ready = false;
		socket.on('open', () => socket.send(JSON.stringify(buildGeminiTranscribeSetup(this.profileId, this.options))));
		socket.on('message', data => this.handleMessage(socket, data.toString()));
		socket.on('error', error => {
			if (socket === this.socket) {
				this.fail(error.message);
			}
		});
		socket.on('close', (code, reason) => {
			if (socket !== this.socket) {
				return;
			}
			if (this.ending) {
				this.finish();
			} else {
				this.fail(`соединение закрыто сервером (${code}${reason.length ? `: ${reason.toString()}` : ''})`);
			}
		});
	}

	private handleMessage(socket: WsTypes.WebSocket, text: string): void {
		const event = parseGeminiLiveMessage(text);
		if (event.error) {
			this.fail(event.error);
			return;
		}
		if (event.setupComplete && socket === this.socket) {
			this.ready = true;
			this.retiring?.close();
			this.retiring = undefined;
			if (!this.announcedReady) {
				this.announcedReady = true;
				this.emit({ sessionId: this.sessionId, type: 'ready' });
			}
			this.flushQueue();
		}
		if (event.interim) {
			this.emit({ sessionId: this.sessionId, type: 'partial', text: event.interim });
		}
		if (event.final) {
			this.emit({ sessionId: this.sessionId, type: 'final', text: event.final });
		}
		if (event.goAway && socket === this.socket && !this.ending) {
			this.logService.info(`[vibeVoice] cloud session ${this.sessionId}: goAway, reconnecting early`);
			this.connect().catch(error => this.fail(error instanceof Error ? error.message : String(error)));
		}
	}

	private flushQueue(): void {
		if (!this.ready || this.socket?.readyState !== this.socket?.OPEN) {
			return;
		}
		for (const message of this.queued.splice(0)) {
			this.socket?.send(message);
		}
	}

	private fail(message: string): void {
		if (this.finished) {
			return;
		}
		this.logService.warn(`[vibeVoice] cloud session ${this.sessionId} failed: ${message}`);
		this.emit({ sessionId: this.sessionId, type: 'error', message });
		this.ending = true;
		this.closeAll();
	}

	private closeAll(): void {
		if (this.stopTimer) {
			clearTimeout(this.stopTimer);
			this.stopTimer = undefined;
		}
		if (this.renewTimer) {
			clearTimeout(this.renewTimer);
			this.renewTimer = undefined;
		}
		this.retiring?.close();
		this.retiring = undefined;
		const socket = this.socket;
		if (socket && socket.readyState !== socket.CLOSED) {
			socket.close();
		}
		this.finish();
	}

	private finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.emit({ sessionId: this.sessionId, type: 'stopped' });
	}
}
