/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { randomBytes } from 'crypto';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { vibeLog } from '../../common/vibeLog.js';
import {
	admitRequest,
	IVibeHttpApiMain,
	MAX_REQUEST_BODY_BYTES,
	parseRunRequest,
	VibeHttpApiPendingRun,
	VibeHttpApiStatus,
	VibeHttpRunResponse,
	VIBE_HTTP_API_VERSION,
} from '../../common/httpApi/vibeHttpApiTypes.js';

/**
 * Incoming HTTP API — the listener.
 *
 * Lives in the main process for the same reason the Telegram poller does: there is exactly one
 * main process per application, and two windows binding the same port would leave the second one
 * broken with `EADDRINUSE` — an API that works or not depending on window count is worse than no
 * API. Windows register themselves; a request is handed to one of them, which owns the agent.
 *
 * The admission decision is NOT here — it is pure and tested in `common/httpApi/vibeHttpApiTypes`.
 * This file only does what needs a socket: bind loopback, read the body with a cap, hand over,
 * answer.
 */

/** How long a request waits for a window to answer before the caller is told the truth. */
const WINDOW_RESPONSE_TIMEOUT_MS = 10 * 60_000;

export class VibeHttpApiMainService extends Disposable implements IVibeHttpApiMain {

	private _server: http.Server | undefined;
	private _port: number | undefined;
	private _token: string | undefined;
	private _lastError: string | undefined;

	private readonly _onRun = this._register(new Emitter<VibeHttpApiPendingRun>());
	readonly onRun: Event<VibeHttpApiPendingRun> = this._onRun.event;

	/**
	 * In-flight requests, keyed by requestId. The timeout handle is kept alongside the resolver so
	 * an answered request cancels its own timer — otherwise every call would leave a ten-minute
	 * timer smouldering, and a busy CI would accumulate thousands of them.
	 */
	private readonly _pending = new Map<string, { readonly resolve: (response: VibeHttpRunResponse) => void; readonly timer: ReturnType<typeof setTimeout> }>();

	async generateToken(): Promise<string> {
		// 256 bits, url-safe. Long enough that guessing is not a threat model worth modelling.
		return randomBytes(32).toString('base64url');
	}

	async start(port: number, token: string): Promise<VibeHttpApiStatus> {
		await this.stop();
		if (!token) {
			// Refusing here keeps the invariant true no matter who calls: no token, no listener.
			this._lastError = 'нет токена';
			return { running: false, error: this._lastError };
		}
		try {
			const httpModule = await import('http');
			const server = httpModule.createServer((req, res) => { void this._handle(req, res); });
			await new Promise<void>((resolve, reject) => {
				server.once('error', reject);
				// '127.0.0.1' and nothing else: binding 0.0.0.0 would put agent execution on the
				// local network, which no setting in this feature ever promises.
				server.listen(port, '127.0.0.1', () => resolve());
			});
			this._server = server;
			this._token = token;
			const address = server.address();
			this._port = typeof address === 'object' && address ? address.port : port;
			this._lastError = undefined;
			vibeLog.info('HttpApi', `слушает 127.0.0.1:${this._port}`);
			return { running: true, port: this._port };
		} catch (err) {
			this._lastError = err instanceof Error ? err.message : String(err);
			vibeLog.error('HttpApi', `не удалось запустить: ${this._lastError}`);
			return { running: false, error: this._lastError };
		}
	}

	async stop(): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._token = undefined;
		this._port = undefined;
		// Answer everyone still waiting instead of leaving sockets to time out: a CI job hanging
		// for ten minutes because the user toggled a setting is a bug report we would deserve.
		for (const [, entry] of this._pending) {
			clearTimeout(entry.timer);
			entry.resolve({ sessionId: '', status: 'failed', error: 'HTTP API остановлен' });
		}
		this._pending.clear();
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	async getStatus(): Promise<VibeHttpApiStatus> {
		return this._server
			? { running: true, port: this._port }
			: { running: false, ...(this._lastError ? { error: this._lastError } : {}) };
	}

	async completeRun(requestId: string, response: VibeHttpRunResponse): Promise<void> {
		const entry = this._pending.get(requestId);
		if (!entry) { return; } // already answered or timed out — nothing to do
		this._pending.delete(requestId);
		clearTimeout(entry.timer);
		entry.resolve(response);
	}

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const verdict = admitRequest({
			hostHeader: req.headers.host,
			authorization: req.headers.authorization,
			remoteAddress: req.socket.remoteAddress,
			expectedToken: this._token,
		});
		if (!verdict.ok) {
			// The reason is safe to return: it names the rule, never the expected token.
			this._json(res, verdict.status, { error: verdict.reason });
			return;
		}

		const url = (req.url ?? '').split('?')[0];
		if (req.method === 'GET' && url === '/health') {
			this._json(res, 200, { ok: true, version: VIBE_HTTP_API_VERSION });
			return;
		}
		if (req.method !== 'POST' || url !== '/run') {
			this._json(res, 404, { error: 'Известны только GET /health и POST /run' });
			return;
		}

		let body: string;
		try {
			body = await this._readBody(req);
		} catch (err) {
			this._json(res, 413, { error: err instanceof Error ? err.message : String(err) });
			return;
		}
		const parsed = parseRunRequest(body);
		if (!parsed.ok) {
			this._json(res, 400, { error: parsed.reason });
			return;
		}

		const requestId = randomBytes(12).toString('hex');
		const answered = new Promise<VibeHttpRunResponse>(resolve => {
			const timer = setTimeout(() => {
				if (this._pending.delete(requestId)) {
					resolve({ sessionId: parsed.value.sessionId ?? '', status: 'failed', error: 'Окно IDE не ответило' });
				}
			}, WINDOW_RESPONSE_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, timer });
		});

		if (this._pending.has(requestId)) {
			this._onRun.fire({ requestId, request: parsed.value });
		}
		const response = await answered;
		this._json(res, response.status === 'failed' ? 500 : 200, response);
	}

	/**
	 * Read the body, refusing anything over the cap.
	 *
	 * Counted in BYTES as they arrive rather than on the assembled string: waiting for the end of
	 * an unbounded upload to discover it was unbounded is how a cap becomes decorative.
	 */
	private _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_REQUEST_BODY_BYTES) {
					reject(new Error(`Тело запроса больше ${MAX_REQUEST_BODY_BYTES} байт`));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	private _json(res: http.ServerResponse, status: number, payload: unknown): void {
		const text = JSON.stringify(payload);
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			// The API is for programs, not pages: no browser may read a response cross-origin.
			'Access-Control-Allow-Origin': 'null',
			'X-Content-Type-Options': 'nosniff',
		});
		res.end(text);
	}

	override dispose(): void {
		void this.stop();
		super.dispose();
	}
}
