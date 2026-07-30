/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A loopback proxy that puts our bridge script into a foreign dev-server's pages.
 *
 * Why: the bridge (element inspect + design scan) is injected by OUR static server, so a Vite/Next
 * preview had neither — `design_review` answered "out of reach" on exactly the projects people
 * actually build. The proxy sits in front of the dev-server and changes ONE thing: navigational
 * HTML gets the script appended. Everything else is forwarded byte-for-byte.
 *
 * What must not break, and how:
 * - **HMR.** Framework dev-servers push updates over a WebSocket. `upgrade` is tunnelled raw —
 *   we pipe both directions and never look inside.
 * - **Streaming.** SSE (`text/event-stream`) and every non-HTML body are piped without buffering,
 *   so a long-lived stream is not held hostage waiting for an end that never comes.
 * - **Compression.** `accept-encoding` is dropped on the way up: a gzipped HTML body cannot be
 *   string-patched, and decompressing to re-compress would be a second thing to get wrong.
 * - **Redirects.** `location` pointing at the upstream origin is rewritten to the proxy origin,
 *   otherwise the first redirect drops the user out of the proxied world and the bridge vanishes.
 *
 * Kept separate from `VibeServerMainService` on purpose: that class serves files from disk, this
 * one forwards someone else's traffic. One reason to change each.
 */

import type * as http from 'http';
import type { Socket } from 'net';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { injectReloadScript } from '../../common/vibeServer/injectReloadScript.js';
import { IVibeBridgeProxyOptions, IVibeServerStarted } from '../../common/vibeServer/vibeServerIpc.js';

/** First port to try; the proxy walks upward on conflict, like the static server. */
const PROXY_BASE_PORT = 5599;
/** How many ports to try before giving up. */
const PROXY_PORT_TRIES = 20;
/** Bodies larger than this are streamed through unpatched — an HTML document that big is not a page. */
const MAX_INJECTED_BODY_BYTES = 8 * 1024 * 1024;
/** Headers that must not be forwarded verbatim (hop-by-hop, or invalidated by our patching). */
const HOP_BY_HOP = new Set([
	'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
	'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export class VibeBridgeProxyMain implements IDisposable {

	private _server: http.Server | undefined;
	private _upstream: URL | undefined;
	private _proxyOrigin: string | undefined;
	/** Open sockets, so stopping frees the port immediately instead of after keep-alive expiry. */
	private readonly _sockets = new Set<Socket>();

	constructor(
		private readonly _log: ILogService,
	) { }

	/** True while the proxy is listening — drives whether the preview may claim bridge support. */
	get active(): boolean {
		return !!this._server;
	}

	async start(options: IVibeBridgeProxyOptions): Promise<IVibeServerStarted> {
		await this.stop();

		let upstream: URL;
		try {
			upstream = new URL(options.upstreamUrl);
		} catch {
			throw new Error(`Не похоже на адрес dev-сервера: ${options.upstreamUrl}`);
		}
		this._upstream = upstream;

		const httpModule = await import('http');
		const server = httpModule.createServer((req, res) => { void this._forward(req, res); });
		this._server = server;
		server.on('connection', socket => {
			this._sockets.add(socket);
			socket.once('close', () => this._sockets.delete(socket));
		});
		server.on('upgrade', (req, socket, head) => this._tunnel(req, socket as Socket, head));
		server.on('error', err => this._log.warn('[VibeBridgeProxy] server error', err));

		const port = await this._listen(server, options.host);
		const url = `http://${options.host}:${port}/`;
		this._proxyOrigin = `http://${options.host}:${port}`;
		this._log.info(`[VibeBridgeProxy] ${url} → ${upstream.origin} (мост инжектируется в HTML)`);
		return { host: options.host, port, url };
	}

	async stop(): Promise<void> {
		const server = this._server;
		this._server = undefined;
		this._upstream = undefined;
		this._proxyOrigin = undefined;
		if (!server) {
			return;
		}
		for (const socket of this._sockets) {
			try { socket.destroy(); } catch { /* already gone */ }
		}
		this._sockets.clear();
		await new Promise<void>(resolve => server.close(() => resolve()));
	}

	dispose(): void {
		void this.stop();
	}

	private async _listen(server: http.Server, host: string): Promise<number> {
		for (let attempt = 0; attempt < PROXY_PORT_TRIES; attempt++) {
			const port = PROXY_BASE_PORT + attempt;
			const ok = await new Promise<boolean>(resolve => {
				const onError = (err: NodeJS.ErrnoException) => {
					server.removeListener('listening', onListening);
					resolve(err.code === 'EADDRINUSE' ? false : Promise.reject(err) as never);
				};
				const onListening = () => {
					server.removeListener('error', onError);
					resolve(true);
				};
				server.once('error', onError);
				server.once('listening', onListening);
				server.listen(port, host);
			});
			if (ok) {
				return port;
			}
		}
		throw new Error(`Свободный порт для прокси не найден (пробовали ${PROXY_BASE_PORT}–${PROXY_BASE_PORT + PROXY_PORT_TRIES - 1})`);
	}

	/** Headers for the upstream request: hop-by-hop dropped, host retargeted, encoding refused. */
	private _upstreamHeaders(incoming: http.IncomingHttpHeaders, upstream: URL): http.OutgoingHttpHeaders {
		const headers: http.OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries(incoming)) {
			if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
				continue;
			}
			headers[name] = value;
		}
		headers['host'] = upstream.host;
		// A compressed body cannot be string-patched; asking for plain text is cheaper and safer
		// than a decompress/recompress round trip we would have to get right for every encoding.
		headers['accept-encoding'] = 'identity';
		return headers;
	}

	private async _forward(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const upstream = this._upstream;
		if (!upstream) {
			res.writeHead(502).end('Прокси не настроен');
			return;
		}
		const httpModule = await import('http');
		const target = new URL(req.url ?? '/', upstream);
		const proxied = httpModule.request(
			{
				protocol: upstream.protocol,
				hostname: upstream.hostname,
				port: upstream.port,
				method: req.method,
				path: target.pathname + target.search,
				headers: this._upstreamHeaders(req.headers, upstream),
			},
			upstreamRes => this._relay(req, res, upstreamRes),
		);
		proxied.on('error', err => {
			this._log.warn(`[VibeBridgeProxy] upstream error: ${err}`);
			if (!res.headersSent) {
				res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
			}
			res.end(`Dev-сервер не ответил: ${err}`);
		});
		req.pipe(proxied);
	}

	private _relay(req: http.IncomingMessage, res: http.ServerResponse, upstreamRes: http.IncomingMessage): void {
		const headers: http.OutgoingHttpHeaders = {};
		for (const [name, value] of Object.entries(upstreamRes.headers)) {
			if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
				continue;
			}
			headers[name] = value;
		}
		// A redirect to the upstream origin would take the page out of the proxied world, and the
		// bridge would silently disappear from that point on.
		const location = upstreamRes.headers['location'];
		const upstreamOrigin = this._upstream?.origin;
		if (typeof location === 'string' && this._proxyOrigin && upstreamOrigin && location.startsWith(upstreamOrigin)) {
			headers['location'] = this._proxyOrigin + location.slice(upstreamOrigin.length);
		}

		const contentType = String(upstreamRes.headers['content-type'] ?? '');
		const isHtml = /text\/html/i.test(contentType);
		const accepts = String(req.headers['accept'] ?? '');
		// Same rule as the static server: only navigational HTML is patched. HTML fetched as data
		// must stay byte-identical, or the live-server class of bug comes back.
		const navigational = req.method === 'GET' && (accepts.includes('text/html') || accepts === '' || accepts === '*/*');

		if (!isHtml || !navigational) {
			res.writeHead(upstreamRes.statusCode ?? 200, headers);
			upstreamRes.pipe(res);
			return;
		}

		const chunks: Buffer[] = [];
		let bytes = 0;
		let overflowed = false;
		upstreamRes.on('data', (chunk: Buffer) => {
			if (overflowed) {
				return;
			}
			bytes += chunk.length;
			if (bytes > MAX_INJECTED_BODY_BYTES) {
				// Give up on patching rather than hold a huge body in memory: flush what we have
				// and stream the rest through untouched.
				overflowed = true;
				res.writeHead(upstreamRes.statusCode ?? 200, headers);
				for (const buffered of chunks) { res.write(buffered); }
				chunks.length = 0;
				res.write(chunk);
				upstreamRes.pipe(res);
				return;
			}
			chunks.push(chunk);
		});
		upstreamRes.on('end', () => {
			if (overflowed) {
				return;
			}
			const patched = injectReloadScript(Buffer.concat(chunks).toString('utf8'));
			const body = Buffer.from(patched, 'utf8');
			// Length changed by the injection; a stale content-length truncates the document.
			delete headers['content-length'];
			headers['content-length'] = body.byteLength;
			res.writeHead(upstreamRes.statusCode ?? 200, headers);
			res.end(body);
		});
		upstreamRes.on('error', err => {
			this._log.warn(`[VibeBridgeProxy] upstream body error: ${err}`);
			res.destroy();
		});
	}

	/** Raw tunnel for `upgrade` requests — this is how the framework's HMR socket survives. */
	private _tunnel(req: http.IncomingMessage, clientSocket: Socket, head: Buffer): void {
		const upstreamUrl = this._upstream;
		if (!upstreamUrl) {
			clientSocket.destroy();
			return;
		}
		void (async () => {
			const httpModule = await import('http');
			const target = new URL(req.url ?? '/', upstreamUrl);
			const proxied = httpModule.request({
				protocol: upstreamUrl.protocol,
				hostname: upstreamUrl.hostname,
				port: upstreamUrl.port,
				method: req.method,
				path: target.pathname + target.search,
				headers: { ...req.headers, host: upstreamUrl.host },
			});
			proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
				const statusLine = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
				for (const [name, value] of Object.entries(upstreamRes.headers)) {
					if (value === undefined) { continue; }
					for (const single of Array.isArray(value) ? value : [value]) {
						statusLine.push(`${name}: ${single}`);
					}
				}
				clientSocket.write(statusLine.join('\r\n') + '\r\n\r\n');
				if (upstreamHead?.length) { clientSocket.write(upstreamHead); }
				upstreamSocket.pipe(clientSocket);
				clientSocket.pipe(upstreamSocket);
				const drop = () => { upstreamSocket.destroy(); clientSocket.destroy(); };
				upstreamSocket.on('error', drop);
				clientSocket.on('error', drop);
			});
			proxied.on('error', err => {
				this._log.warn(`[VibeBridgeProxy] upgrade error: ${err}`);
				clientSocket.destroy();
			});
			if (head?.length) { proxied.write(head); }
			proxied.end();
		})();
	}
}
