/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Vibe Server — static document server with live reload, running in electron-main (node).
 * The renderer drives it over `VIBE_SERVER_CHANNEL` (see common/vibeServer/vibeServerIpc.ts).
 * Single instance at a time (Phase 0). Binds loopback only; reload is broadcast over `ws`.
 */

import type * as http from 'http';
import * as path from '../../../../../base/common/path.js';
import * as url from 'url';
import * as os from 'os';
import { promises as fs } from 'fs';
import type { Socket } from 'net';
import type * as wsTypes from 'ws';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { injectReloadScript, VIBE_RELOAD_WS_PATH } from '../../common/vibeServer/injectReloadScript.js';
import { IVibeServerMain, IVibeServerStartOptions, IVibeServerStarted, VibeServerChangeKind } from '../../common/vibeServer/vibeServerIpc.js';

/** Base port the server walks upward from when the desired port is busy. */
const DEFAULT_BASE_PORT = 5500;
/** How many sequential ports to probe before giving up. */
const MAX_PORT_ATTEMPTS = 50;
/** `ws` readyState for an open connection (avoids importing the enum at runtime). */
const WS_OPEN = 1;

/** Minimal extension → Content-Type map for dev assets (avoids a `mime` dependency). */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
};

function escapeHtml(text: string): string {
	return text.replace(/[&<>"]/g, ch => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;'));
}

export class VibeServerMainService implements IVibeServerMain, IDisposable {

	private _server: http.Server | undefined;
	private _wss: wsTypes.WebSocketServer | undefined;
	private _options: IVibeServerStartOptions | undefined;
	/** Open TCP sockets tracked so `stop()` can force-close them and free the port immediately. */
	private readonly _sockets = new Set<Socket>();

	constructor(
		@ILogService private readonly _log: ILogService,
	) { }

	async start(options: IVibeServerStartOptions): Promise<IVibeServerStarted> {
		await this.stop();
		this._options = options;

		const wsModule = await import('ws');
		const server = options.https
			? (await import('https')).createServer(await this._generateCert(options.host), (req, res) => { void this._handle(req, res); })
			: (await import('http')).createServer((req, res) => { void this._handle(req, res); });
		this._server = server;
		server.on('connection', socket => {
			this._sockets.add(socket);
			socket.once('close', () => this._sockets.delete(socket));
		});

		const wss = new wsModule.WebSocketServer({ server, path: VIBE_RELOAD_WS_PATH });
		wss.on('error', err => this._log.warn('[VibeServer] websocket server error', err));
		this._wss = wss;

		const port = await this._listen(server, options.host, options.port);
		server.on('error', err => this._log.warn('[VibeServer] server error', err));

		const scheme = options.https ? 'https' : 'http';
		const started: IVibeServerStarted = { host: options.host, port, url: `${scheme}://${options.host}:${port}/` };
		this._log.info(`[VibeServer] listening on ${started.url} (root: ${options.rootFsPath})`);
		return started;
	}

	async stop(): Promise<void> {
		this._options = undefined;

		const wss = this._wss;
		this._wss = undefined;
		if (wss) {
			for (const client of wss.clients) {
				try { client.terminate(); } catch { /* already closing */ }
			}
			await new Promise<void>(resolve => wss.close(() => resolve()));
		}

		const server = this._server;
		this._server = undefined;
		if (server) {
			for (const socket of this._sockets) {
				try { socket.destroy(); } catch { /* already destroyed */ }
			}
			this._sockets.clear();
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	}

	async lanAddress(): Promise<string | undefined> {
		for (const addresses of Object.values(os.networkInterfaces())) {
			for (const addr of addresses ?? []) {
				if (addr.family === 'IPv4' && !addr.internal) {
					return addr.address;
				}
			}
		}
		return undefined;
	}

	/** Generates an in-memory self-signed certificate for loopback HTTPS (never persisted). */
	private async _generateCert(host: string): Promise<{ key: string; cert: string }> {
		const selfsigned = await import('selfsigned');
		const pems = selfsigned.generate(
			[{ name: 'commonName', value: host }],
			{
				days: 365,
				keySize: 2048,
				extensions: [{
					name: 'subjectAltName',
					altNames: [
						{ type: 2, value: 'localhost' },
						{ type: 7, ip: '127.0.0.1' },
					],
				}],
			},
		);
		return { key: pems.private, cert: pems.cert };
	}

	async notifyChange(kind: VibeServerChangeKind): Promise<void> {
		const wss = this._wss;
		if (!wss) {
			return;
		}
		const payload = kind === 'css' ? 'css' : 'reload';
		for (const client of wss.clients) {
			if (client.readyState === WS_OPEN) {
				try { client.send(payload); } catch { /* client gone */ }
			}
		}
	}

	dispose(): void {
		void this.stop();
	}

	/** Listens on `host`, walking the port upward from the desired base on conflict. */
	private _listen(server: http.Server, host: string, desiredPort: number): Promise<number> {
		const startPort = desiredPort && desiredPort > 0 ? desiredPort : DEFAULT_BASE_PORT;
		return new Promise<number>((resolve, reject) => {
			let current = startPort;
			let attempts = 0;
			const onError = (err: NodeJS.ErrnoException) => {
				if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempts < MAX_PORT_ATTEMPTS) {
					attempts++;
					current++;
					setImmediate(tryOnce);
					return;
				}
				reject(err);
			};
			const tryOnce = () => {
				server.once('error', onError);
				server.listen(current, host, () => {
					server.removeListener('error', onError);
					resolve(current);
				});
			};
			tryOnce();
		});
	}

	private async _handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const options = this._options;
		try {
			if (!options) {
				res.statusCode = 503;
				res.end('Vibe Server stopped');
				return;
			}
			const method = req.method ?? 'GET';
			if (method !== 'GET' && method !== 'HEAD') {
				res.statusCode = 405;
				res.setHeader('Allow', 'GET, HEAD');
				res.end();
				return;
			}

			const root = path.resolve(options.rootFsPath);
			const pathname = decodeURIComponent(url.parse(req.url ?? '/').pathname ?? '/');
			const relative = pathname.replace(/^\/+/, '');
			const target = relative ? path.resolve(root, relative) : root;

			// Path-traversal guard: resolved target must stay within the document root.
			if (target !== root && !target.startsWith(root + path.sep)) {
				this._notFound(res);
				return;
			}

			// Directory: redirect to trailing slash (so relative links resolve), then serve
			// index.html or an auto-generated listing.
			const stat = await this._statSafe(target);
			if (stat?.isDirectory()) {
				if (!pathname.endsWith('/')) {
					res.statusCode = 301;
					res.setHeader('Location', pathname + '/');
					res.end();
					return;
				}
				const index = path.join(target, 'index.html');
				if ((await this._statSafe(index))?.isFile()) {
					await this._serveFile(index, method, res);
					return;
				}
				await this._serveListing(target, pathname, method, res);
				return;
			}

			let filePath = await this._resolveFile(target);
			if (!filePath && options.spaFallback) {
				const fallback = path.resolve(root, options.spaFallback.replace(/^\/+/, ''));
				if (fallback === root || fallback.startsWith(root + path.sep)) {
					filePath = await this._resolveFile(fallback);
				}
			}
			if (!filePath) {
				this._notFound(res);
				return;
			}
			await this._serveFile(filePath, method, res);
		} catch (err) {
			this._log.error('[VibeServer] request failed', err);
			if (!res.headersSent) {
				res.statusCode = 500;
			}
			res.end();
		}
	}

	/** Resolves a path to a servable file (directories are handled earlier in `_handle`). */
	private async _resolveFile(candidate: string): Promise<string | undefined> {
		return (await this._statSafe(candidate))?.isFile() ? candidate : undefined;
	}

	private async _serveFile(filePath: string, method: string, res: http.ServerResponse): Promise<void> {
		const ext = path.extname(filePath).toLowerCase();
		const isHtml = ext === '.html' || ext === '.htm';
		// Dev assets must never be cached so reloads always show fresh content.
		res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

		if (isHtml) {
			// Reload script is injected ONLY here — navigational HTML responses.
			const injected = injectReloadScript(await fs.readFile(filePath, 'utf8'));
			const buffer = Buffer.from(injected, 'utf8');
			res.statusCode = 200;
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.setHeader('Content-Length', String(buffer.byteLength));
			res.end(method === 'HEAD' ? undefined : buffer);
			return;
		}

		const data = await fs.readFile(filePath);
		res.statusCode = 200;
		res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
		res.setHeader('Content-Length', String(data.byteLength));
		res.end(method === 'HEAD' ? undefined : data);
	}

	private _notFound(res: http.ServerResponse): void {
		res.statusCode = 404;
		res.setHeader('Content-Type', 'text/plain; charset=utf-8');
		res.end('404 Not Found');
	}

	private async _statSafe(p: string): Promise<{ isDirectory(): boolean; isFile(): boolean } | undefined> {
		try {
			return await fs.stat(p);
		} catch {
			return undefined;
		}
	}

	/** Generates a simple directory listing for folders without an index.html. */
	private async _serveListing(dir: string, pathname: string, method: string, res: http.ServerResponse): Promise<void> {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		const rows = entries
			.filter(e => !e.name.startsWith('.'))
			.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
			.map(e => {
				const label = e.name + (e.isDirectory() ? '/' : '');
				const href = encodeURIComponent(e.name) + (e.isDirectory() ? '/' : '');
				return `<li><a href="${href}">${escapeHtml(label)}</a></li>`;
			});
		const up = pathname !== '/' ? '<li><a href="../">../</a></li>' : '';
		const title = escapeHtml(pathname);
		const body = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title>`
			+ '<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}a{text-decoration:none;color:#0969da}li{margin:.25rem 0;list-style:none}ul{padding:0}h2{font-size:1.1rem}</style>'
			+ `</head><body><h2>${title}</h2><ul>${up}${rows.join('')}</ul></body></html>`;
		const buffer = Buffer.from(body, 'utf8');
		res.statusCode = 200;
		res.setHeader('Content-Type', 'text/html; charset=utf-8');
		res.setHeader('Cache-Control', 'no-cache');
		res.setHeader('Content-Length', String(buffer.byteLength));
		res.end(method === 'HEAD' ? undefined : buffer);
	}
}
