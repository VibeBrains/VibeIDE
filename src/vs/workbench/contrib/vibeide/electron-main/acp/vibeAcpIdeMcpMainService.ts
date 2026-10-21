/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as http from 'http';
import { randomBytes } from 'crypto';
import { Sequencer } from '../../../../../base/common/async.js';
import { isLoopbackHost, isRemoteLoopback, secretEquals } from '../../../../../base/common/loopbackAdmission.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IWindowsMainService } from '../../../../../platform/windows/electron-main/windows.js';
import { vibeLog } from '../../common/vibeLog.js';
import { IDE_MCP_MAX_BODY_BYTES, IDE_MCP_SERVER_NAME, IIdeMcpToolResult, handleIdeMcpBody, ideMcpToolTimeoutMs } from '../../common/acp/acpIdeMcp.js';
import { IIdeMcpCall, IIdeMcpIssued, IVibeAcpIdeMcpMain } from '../../common/acp/acpIdeMcpTypes.js';

/** The path the agent connects to */
const MCP_PATH = '/mcp';

interface ITokenOwner {
	readonly windowId: number;
	readonly instanceId: string;
}

interface IPendingCall {
	readonly resolve: (result: IIdeMcpToolResult) => void;
	readonly timer: ReturnType<typeof setTimeout>;
	readonly token: string;
}

/**
 * The editor's MCP server for external agents — the socket
 *
 * It lives in the main process because the agent processes do: one listener per application. Every agent session gets
 * a token of its own, bound to the window that started it; the listener answers a call by asking exactly that window
 * Binding is `127.0.0.1` and nothing else, and a request must pass the same loopback and `Host` checks as the rest
 * of the local listeners: the editor's open file is not for the network or for a page that points its domain here
 */
export class VibeAcpIdeMcpMainService extends Disposable implements IVibeAcpIdeMcpMain {

	private readonly _onToolCall = this._register(new Emitter<IIdeMcpCall>());
	readonly onToolCall: Event<IIdeMcpCall> = this._onToolCall.event;

	private _server: http.Server | undefined;
	private _port: number | undefined;
	private readonly _tokens = new Map<string, ITokenOwner>();
	private readonly _pending = new Map<string, IPendingCall>();
	/** Windows ask for tokens at the same time; opening and closing the listener must not race for the port */
	private readonly _listenerChanges = new Sequencer();

	constructor(windows: Pick<IWindowsMainService, 'onDidDestroyWindow'>) {
		super();
		// A closed window leaves no one to answer: its tokens end and its waiting calls are told so
		this._register(windows.onDidDestroyWindow(window => this._retireWindow(window.id)));
	}

	async issue(windowId: number, instanceId: string): Promise<IIdeMcpIssued> {
		const port = await this._listenerChanges.queue(() => this._ensureListening());
		// 256 bits, url-safe: a guess is not a threat worth modelling
		const token = randomBytes(32).toString('base64url');
		this._tokens.set(token, { windowId, instanceId });
		return {
			token,
			server: {
				type: 'http',
				name: IDE_MCP_SERVER_NAME,
				url: `http://127.0.0.1:${port}${MCP_PATH}`,
				headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
			},
		};
	}

	async revoke(token: string): Promise<void> {
		if (!this._tokens.delete(token)) { return; }
		this._releasePending(entry => entry.token === token, 'Сессия агента закончилась');
		await this._listenerChanges.queue(() => this._closeWhenUnused());
	}

	async completeToolCall(callId: string, result: IIdeMcpToolResult): Promise<void> {
		const entry = this._pending.get(callId);
		if (!entry) { return; } // already answered or timed out
		this._pending.delete(callId);
		clearTimeout(entry.timer);
		entry.resolve(result);
	}

	private _retireWindow(windowId: number): void {
		const gone = [...this._tokens].filter(([, owner]) => owner.windowId === windowId).map(([token]) => token);
		for (const token of gone) {
			this._tokens.delete(token);
		}
		this._releasePending(entry => gone.includes(entry.token), 'Окно IDE закрыто');
		void this._listenerChanges.queue(() => this._closeWhenUnused());
	}

	private _releasePending(matches: (entry: IPendingCall) => boolean, reason: string): void {
		for (const [callId, entry] of this._pending) {
			if (!matches(entry)) { continue; }
			this._pending.delete(callId);
			clearTimeout(entry.timer);
			entry.resolve({ text: reason, isError: true });
		}
	}

	private async _ensureListening(): Promise<number> {
		if (this._server && this._port !== undefined) { return this._port; }
		const httpModule = await import('http');
		const server = httpModule.createServer((req, res) => { void this._handle(req, res); });
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			// Port 0: the system gives a free one, and the agent learns it from the entry it is handed
			server.listen(0, '127.0.0.1', () => resolve());
		});
		const address = server.address();
		this._server = server;
		this._port = typeof address === 'object' && address ? address.port : undefined;
		if (this._port === undefined) {
			await this._close();
			throw new Error('MCP-сервер редактора не получил порт');
		}
		vibeLog.info('ACP', `MCP-сервер редактора слушает 127.0.0.1:${this._port}`);
		return this._port;
	}

	private async _closeWhenUnused(): Promise<void> {
		if (this._tokens.size === 0) {
			await this._close();
		}
	}

	private async _close(): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._port = undefined;
		if (server) {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	/** The owner of the token the request carries, or `undefined`; every token is compared, so the time does not tell which one was close */
	private _ownerOf(authorization: string | undefined): { readonly token: string; readonly owner: ITokenOwner } | undefined {
		const prefix = 'bearer ';
		const header = authorization ?? '';
		if (header.slice(0, prefix.length).toLowerCase() !== prefix) { return undefined; }
		const given = header.slice(prefix.length).trim();
		let found: { readonly token: string; readonly owner: ITokenOwner } | undefined;
		for (const [token, owner] of this._tokens) {
			if (secretEquals(given, token)) { found = { token, owner }; }
		}
		return found;
	}

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		// The host check runs before the token check: a rebinding page is refused without being told whether its guess was right
		if (!isRemoteLoopback(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
			this._plain(res, 403, 'Только с этого компьютера');
			return;
		}
		const caller = this._ownerOf(req.headers.authorization);
		if (!caller) {
			this._plain(res, 401, 'Нужен заголовок Authorization: Bearer <токен сессии>');
			return;
		}
		if ((req.url ?? '').split('?')[0] !== MCP_PATH) {
			this._plain(res, 404, 'Есть только /mcp');
			return;
		}
		// The server offers no stream of its own: the client that asks for one is told the method is not here
		if (req.method !== 'POST') {
			res.writeHead(405, { Allow: 'POST' });
			res.end();
			return;
		}
		let body: string;
		try {
			body = await this._readBody(req);
		} catch (err) {
			this._plain(res, 413, err instanceof Error ? err.message : String(err));
			return;
		}
		const reply = await handleIdeMcpBody(body, (tool, args) => this._callWindow(caller.token, caller.owner, tool, args));
		if (reply.body === undefined) {
			res.writeHead(reply.status);
			res.end();
			return;
		}
		res.writeHead(reply.status, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
		res.end(JSON.stringify(reply.body));
	}

	private _callWindow(token: string, owner: ITokenOwner, tool: string, args: IIdeMcpCall['args']): Promise<IIdeMcpToolResult> {
		const callId = generateUuid();
		const timeoutMs = ideMcpToolTimeoutMs(tool);
		return new Promise<IIdeMcpToolResult>(resolve => {
			const timer = setTimeout(() => {
				if (this._pending.delete(callId)) {
					resolve({ text: `Окно IDE не ответило за ${Math.round(timeoutMs / 1000)} с`, isError: true });
				}
			}, timeoutMs);
			this._pending.set(callId, { resolve, timer, token });
			this._onToolCall.fire({ callId, instanceId: owner.instanceId, tool, args });
		});
	}

	/** The body, refused past the cap while it arrives: waiting for the end of an unbounded upload to find it unbounded makes the cap decorative */
	private _readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > IDE_MCP_MAX_BODY_BYTES) {
					reject(new Error(`Тело запроса больше ${IDE_MCP_MAX_BODY_BYTES} байт`));
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			req.on('error', reject);
		});
	}

	private _plain(res: http.ServerResponse, status: number, text: string): void {
		res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
		res.end(text);
	}

	override dispose(): void {
		this._releasePending(() => true, 'IDE закрывается');
		this._tokens.clear();
		void this._close();
		super.dispose();
	}
}
