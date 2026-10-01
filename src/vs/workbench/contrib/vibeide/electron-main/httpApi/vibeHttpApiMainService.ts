/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { randomBytes } from 'crypto';
import { Sequencer } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../../base/common/lifecycle.js';
import { ICodeWindow } from '../../../../../platform/window/electron-main/window.js';
import { IWindowsMainService } from '../../../../../platform/windows/electron-main/windows.js';
import { vibeLog } from '../../common/vibeLog.js';
import {
	admitRequest,
	httpStatusOfRun,
	IVibeHttpApiMain,
	MAX_REQUEST_BODY_BYTES,
	parseRunPath,
	parseRunRequest,
	VibeHttpApiPendingRun,
	VibeHttpApiRegistration,
	VibeHttpApiRegistrationResult,
	VibeHttpApiStatus,
	VibeHttpRunReport,
	VibeHttpRunResponse,
	VIBE_HTTP_API_VERSION,
} from '../../common/httpApi/vibeHttpApiTypes.js';
import { VibeHttpRunRegistry } from '../../common/httpApi/vibeHttpRunRegistry.js';
import { VibeHttpWindowRoster } from '../../common/httpApi/vibeHttpWindowRoster.js';

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

/** The window events the service needs: a reload or a close ends every run the window was executing */
export type VibeHttpApiWindowEvents = Pick<IWindowsMainService, 'getWindows' | 'onDidOpenWindow' | 'onDidDestroyWindow'>;

interface PendingRequest {
	readonly resolve: (response: VibeHttpRunResponse) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	/** The window instance the request was handed to */
	readonly instanceId: string;
	/** Known once the window reports the thread it chose: from then on the caller can be sent to poll */
	sessionId?: string;
}

export class VibeHttpApiMainService extends Disposable implements IVibeHttpApiMain {

	private _server: http.Server | undefined;
	/** The port asked for — 0 means «any» — so a re-registration with the same request does not rebind */
	private _requestedPort: number | undefined;
	private _port: number | undefined;
	private _token: string | undefined;
	private _lastError: string | undefined;

	private readonly _onRun = this._register(new Emitter<VibeHttpApiPendingRun>());
	readonly onRun: Event<VibeHttpApiPendingRun> = this._onRun.event;

	private readonly _roster = new VibeHttpWindowRoster();
	/**
	 * The last instance each window registered, serving or not
	 * Kept past unregistering: an instance that turned the API off still runs what it started, and its runs end with it
	 */
	private readonly _instanceOfWindow = new Map<number, string>();
	/** Not cleared by stopping the listener: a caller polls a run across a token rotation or a window reload */
	private readonly _runs = new VibeHttpRunRegistry(() => Date.now());
	/** Listener changes come from several windows at once; binding while closing would race for the port */
	private readonly _listenerChanges = new Sequencer();
	private readonly _loadListeners = this._register(new DisposableMap<number>());

	/**
	 * In-flight requests, keyed by requestId. The timeout handle is kept alongside the resolver so
	 * an answered request cancels its own timer — otherwise every call would leave a ten-minute
	 * timer smouldering, and a busy CI would accumulate thousands of them.
	 */
	private readonly _pending = new Map<string, PendingRequest>();

	constructor(windows: VibeHttpApiWindowEvents) {
		super();
		// A load event covers reload and opening another folder in the same window
		// The renderer that ran the agent is gone either way, and its instance must stop owning the API
		const watch = (window: ICodeWindow) => this._loadListeners.set(window.id, window.onWillLoad(() => void this._retireWindow(window.id)));
		for (const window of windows.getWindows()) {
			watch(window);
		}
		this._register(windows.onDidOpenWindow(watch));
		this._register(windows.onDidDestroyWindow(window => {
			this._loadListeners.deleteAndDispose(window.id);
			void this._retireWindow(window.id);
		}));
	}

	async generateToken(): Promise<string> {
		// 256 bits, url-safe. Long enough that guessing is not a threat model worth modelling.
		return randomBytes(32).toString('base64url');
	}

	async register(registration: VibeHttpApiRegistration): Promise<VibeHttpApiRegistrationResult> {
		if (!registration.token) {
			// Refusing here keeps the invariant true no matter who calls: no token, no listener.
			return { running: false, error: 'нет токена', owner: false };
		}
		// Another instance of the same window means that window reloaded
		// The old instance and its runs are gone, whether or not it still served the API
		const previous = this._instanceOfWindow.get(registration.windowId);
		if (previous !== undefined && previous !== registration.instanceId) {
			this._endRunsOf(previous, 'Окно IDE перезагрузилось — прогон прерван');
		}
		this._instanceOfWindow.set(registration.windowId, registration.instanceId);
		this._roster.register(registration);
		const status = await this._syncListener();
		const owner = this._roster.owner?.instanceId === registration.instanceId;
		if (owner) {
			vibeLog.info('HttpApi', `запросы обслуживает окно ${registration.windowId}`);
		}
		return { ...status, owner };
	}

	async unregister(instanceId: string): Promise<void> {
		if (!this._roster.unregister(instanceId)) {
			return;
		}
		// The window is alive and its runs go on; waiting callers are sent to poll instead of being dropped
		this._releasePending(entry => entry.instanceId === instanceId, 'HTTP API выключен в окне, которое выполняло запрос');
		await this._syncListener();
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

	async reportRun(report: VibeHttpRunReport): Promise<void> {
		this._runs.report(report);
		const pending = this._pending.get(report.requestId);
		if (pending) {
			pending.sessionId = report.sessionId;
		}
	}

	/** A window reloaded or closed: its runs died with its renderer, and the next window in line takes over */
	private async _retireWindow(windowId: number): Promise<void> {
		// An instance that already withdrew from serving still counts: a run it started died with it all the same
		const instanceId = this._instanceOfWindow.get(windowId);
		if (instanceId !== undefined) {
			this._endRunsOf(instanceId, 'Окно IDE закрыто или перезагружено — прогон прерван');
			this._instanceOfWindow.delete(windowId);
		}
		if (this._roster.retireWindow(windowId).length > 0) {
			await this._syncListener();
		}
	}

	private _endRunsOf(instanceId: string, error: string): void {
		this._runs.failRunsOf(instanceId, error);
		this._releasePending(entry => entry.instanceId === instanceId, error);
	}

	/**
	 * Answer waiting callers now rather than at the ten-minute timeout
	 * A caller whose run already has a session gets where it stands (202 while unfinished) and can poll
	 * The rest get the reason
	 */
	private _releasePending(matches: (entry: PendingRequest) => boolean, reason: string): void {
		for (const [requestId, entry] of this._pending) {
			if (!matches(entry)) {
				continue;
			}
			this._pending.delete(requestId);
			clearTimeout(entry.timer);
			entry.resolve(this._whereRunStands(entry.sessionId, reason));
		}
	}

	private _whereRunStands(sessionId: string | undefined, reason: string): VibeHttpRunResponse {
		if (!sessionId) {
			return { sessionId: '', status: 'failed', error: reason };
		}
		const snapshot = this._runs.get(sessionId);
		if (!snapshot) {
			return { sessionId, status: 'running' };
		}
		return {
			sessionId,
			status: snapshot.status,
			...(snapshot.answer !== undefined ? { answer: snapshot.answer } : {}),
			...(snapshot.answerTruncated ? { answerTruncated: true } : {}),
			...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
		};
	}

	/** Bring the listener in line with the owner: its port, its token, or nothing when no window serves the API */
	private _syncListener(): Promise<VibeHttpApiStatus> {
		return this._listenerChanges.queue(async () => {
			const owner = this._roster.owner;
			if (!owner) {
				await this._stopListener('HTTP API остановлен');
				return this.getStatus();
			}
			if (this._server && this._requestedPort === owner.port) {
				// Same port: only the token may have changed, and swapping it keeps waiting callers connected
				this._token = owner.token;
				return this.getStatus();
			}
			await this._stopListener('HTTP API перезапущен на другом порту');
			return this._startListener(owner.port, owner.token);
		});
	}

	private async _startListener(port: number, token: string): Promise<VibeHttpApiStatus> {
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
			this._requestedPort = port;
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

	private async _stopListener(reason: string): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._token = undefined;
		this._port = undefined;
		this._requestedPort = undefined;
		// Answer everyone still waiting instead of leaving sockets to time out: a CI job hanging
		// for ten minutes because the user toggled a setting is a bug report we would deserve.
		this._releasePending(() => true, reason);
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
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

		const url = req.url ?? '';
		const path = url.split('?')[0];
		if (req.method === 'GET' && path === '/health') {
			this._json(res, 200, { ok: true, version: VIBE_HTTP_API_VERSION });
			return;
		}
		const runPath = parseRunPath(url);
		if (req.method === 'GET' && runPath) {
			if (!runPath.ok) {
				this._json(res, 400, { error: 'sessionId в пути — латиница, цифры и дефис, не длиннее 64 символов' });
				return;
			}
			const snapshot = this._runs.get(runPath.sessionId);
			if (!snapshot) {
				this._json(res, 404, { error: 'Прогон этой сессии неизвестен: его не было, он устарел (час после завершения) или IDE перезапускалась' });
				return;
			}
			this._json(res, 200, snapshot);
			return;
		}
		if (req.method !== 'POST' || path !== '/run') {
			this._json(res, 404, { error: 'Известны только GET /health, POST /run и GET /run/<sessionId>' });
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
		const owner = this._roster.owner;
		if (!owner) {
			this._json(res, 503, { error: 'Нет окна IDE, готового принять задачу' });
			return;
		}

		const requestId = randomBytes(12).toString('hex');
		const answered = new Promise<VibeHttpRunResponse>(resolve => {
			const timer = setTimeout(() => {
				const entry = this._pending.get(requestId);
				if (entry) {
					this._pending.delete(requestId);
					// A run that has a session is merely long: say where it stands so the caller can poll
					resolve(this._whereRunStands(entry.sessionId, 'Окно IDE не ответило'));
				}
			}, WINDOW_RESPONSE_TIMEOUT_MS);
			this._pending.set(requestId, { resolve, timer, instanceId: owner.instanceId });
		});

		this._onRun.fire({ requestId, instanceId: owner.instanceId, request: parsed.value });
		const response = await answered;
		this._json(res, httpStatusOfRun(response.status), response);
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
		void this._stopListener('HTTP API остановлен');
		super.dispose();
	}
}
