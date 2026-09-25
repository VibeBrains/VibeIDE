/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// registered in app.ts
// can't make a service responsible for this, because it needs
// to be connected to the main process and node dependencies

import { vibeLog } from '../common/vibeLog.js';
import { IConnectionHub, IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { ILifecycleMainService } from '../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
// MCP SDK client/transport modules are heavy and electron-main start-up sensitive; they are
// loaded lazily via `await import(...)` inside `_createClientUnsafe`. Type-only positions use
// inline `import('...')` type expressions so no value import reaches module scope.
import { MCPConfigFileEntryJSON, MCPServer, MCPTool, RawMCPToolCall, MCPToolErrorResponse, MCPServerEventResponse, MCPToolCallParams, MCPReadResourceParams, MCPAppRequestOutcome, MCPSyncParams } from '../common/mcpServiceTypes.js';
import { MCP } from '../../mcp/common/modelContextProtocol.js';
import { mcpAppsClientCapabilities } from '../common/mcpApps.js';
import { KnownMCPServer, MCPServerAction, mcpServerFingerprint, reconcileMCPServers, WantedMCPServer } from '../common/mcpReconcile.js';
import { describeUnauthorizedHelper, helperHeadersOf, mergeServerEnv, transportRequestInit } from '../common/mcpServerEnv.js';
import { McpCacheableMeta, parseCacheableMeta, refreshDelayMs } from '../common/mcpCacheableResult.js';
import { describeUnansweredInput, parseInputRequired, withInputResponses } from '../common/mcpMultiRoundTrip.js';
import { describeProtocolMismatch, MAX_INPUT_ROUNDS, McpInputAnswer, McpInputAsk, planInputRequests } from '../common/mcpElicitation.js';
import { filterToolsWithValidHeaders } from '../common/mcpHeaderAnnotation.js';

/** Сколько ждать человека, прежде чем снять вопрос и отпустить вызов инструмента. */
const INPUT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** How long quitting the app waits for MCP clients to close before it goes on without them. */
const CLOSE_ON_SHUTDOWN_TIMEOUT_MS = 3000;
/** How long a `headersHelper` may take; VibeMemory's reads a file and prints a line */
const HEADERS_HELPER_TIMEOUT_MS = 10_000;
/** A header object is a few hundred bytes; anything past this is not one */
const HEADERS_HELPER_MAX_OUTPUT = 64 * 1024;

const getClientConfig = (serverName: string) => {
	return {
		name: `${serverName}-client`,
		version: '0.1.0',
		// debug: true,
	};
};

type MCPServerNonError = MCPServer & { status: Omit<MCPServer['status'], 'error'> };
type MCPServerError = MCPServer & { status: 'error' };

/**
 * A server the main process has set up for every window — running or not. We call MCP clients «servers»
 * everywhere except in `client`, which is the SDK client connected to that server.
 */
type ClientInfo = {
	/** The entry it was last set up from; a toggle relaunches from it. */
	entry: MCPConfigFileEntryJSON;
	/** `mcpServerFingerprint` of the launch it runs, or last tried — what the next sync compares with. */
	fingerprint: string;
	/** The live client; absent while the server does not run — switched off, or failed to start. */
	client?: import('@modelcontextprotocol/sdk/client/index.js').Client;
	mcpServer: MCPServer;
};

type InfoOfClientId = {
	[clientId: string]: ClientInfo;
};

/** What the server list shows as a server's command: the command line, or the address. */
function displayCommandOf(entry: MCPConfigFileEntryJSON): string {
	if (entry.command) {
		return `${entry.command} ${entry.args?.join(' ') || ''}`;
	}
	return entry.url === undefined ? '' : String(entry.url);
}

/**
 * MCP clients of the whole app. They live here, in the main process, and every window shares them, so
 * what runs here is the only truth about what runs: a window states the servers it wants
 * (`syncMCPServers`) and this channel brings the running set in line (common/mcpReconcile.ts).
 */
export class MCPChannel extends Disposable implements IServerChannel {

	private readonly infoOfClientId: InfoOfClientId = {};
	/** Таймеры перечитывания списка инструментов: по одному на сервер, объявивший срок годности. */
	private readonly _toolListTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/**
	 * On/off as switched in this session, from any window. It wins over a window's view in a sync: each
	 * window reads its settings once, so another window may still hold the state from before the switch.
	 */
	private readonly _isOnOfName = new Map<string, boolean>();
	/** Each window's MCP Apps setting by IPC context; clients announce MCP Apps while any window has it on. */
	private readonly _appsEnabledOfWindow = new Map<string, boolean>();
	/** Syncs and toggles run one at a time: two windows syncing at once would each start the same server. */
	private _queue: Promise<void> = Promise.resolve();

	// mcp emitters
	private readonly mcpEmitters = {
		serverEvent: {
			onAdd: new Emitter<MCPServerEventResponse>(),
			onUpdate: new Emitter<MCPServerEventResponse>(),
			onDelete: new Emitter<MCPServerEventResponse>(),
		}
	} satisfies {
		serverEvent: {
			onAdd: Emitter<MCPServerEventResponse>;
			onUpdate: Emitter<MCPServerEventResponse>;
			onDelete: Emitter<MCPServerEventResponse>;
		};
	};

	constructor(
		connections: IConnectionHub<string>,
		lifecycleMainService: ILifecycleMainService,
	) {
		super();
		// A closed window has no more say in what the clients announce; a reloaded one says it again in its sync.
		this._register(connections.onDidRemoveConnection(connection => this._appsEnabledOfWindow.delete(connection.ctx)));
		// The clients end with the app instead of outliving it as orphaned server processes. Deliberately not
		// registered with this channel: the app disposes its channels in an earlier listener of this same event,
		// and a disposed listener is skipped — the clients would never be closed.
		Event.once(lifecycleMainService.onWillShutdown)(e => e.join('vibeide.mcp.closeClients', this._closeAllClients()));
	}

	/**
	 * Просьбы сервера о вводе, ждущие ответа из окна.
	 *
	 * Клиент MCP живёт в главном процессе, а спросить человека может только окно — отсюда мост
	 * «главный процесс → окно → главный процесс»: событие туда, вызов `answerInputRequest` обратно.
	 */
	private readonly _pendingInput = new Map<string, { resolve: (value: McpInputAnswer) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly _onInputRequest = new Emitter<McpInputAsk>();
	private _inputRequestSeq = 0;

	/** Ответ окна на просьбу сервера. Неизвестный id — окно опоздало: вопрос уже снят по времени. */
	private _resolveInputRequest(requestId: string, answer: McpInputAnswer): void {
		const pending = this._pendingInput.get(requestId);
		if (!pending) { return; }
		clearTimeout(pending.timer);
		this._pendingInput.delete(requestId);
		pending.resolve(answer);
	}

	/**
	 * Спросить окно и дождаться ответа.
	 *
	 * Ожидание ограничено по времени: вопрос без человека у экрана иначе держал бы вызов
	 * инструмента открытым до конца сессии, а сервер — открытым свой `requestState`.
	 */
	private _askWindowForInput(ask: McpInputAsk): Promise<McpInputAnswer> {
		return new Promise<McpInputAnswer>(resolve => {
			const timer = setTimeout(() => {
				this._pendingInput.delete(ask.requestId);
				resolve({ ok: false, reason: 'ответа от пользователя не было — вопрос снят по времени' });
			}, INPUT_REQUEST_TIMEOUT_MS);
			this._pendingInput.set(ask.requestId, { resolve, timer });
			this._onInputRequest.fire(ask);
		});
	}

	// browser uses this to listen for changes
	listen<T>(_: unknown, event: string): Event<T> {

		// server events
		if (event === 'onAdd_server') { return this.mcpEmitters.serverEvent.onAdd.event as Event<T>; }
		else if (event === 'onUpdate_server') { return this.mcpEmitters.serverEvent.onUpdate.event as Event<T>; }
		else if (event === 'onDelete_server') { return this.mcpEmitters.serverEvent.onDelete.event as Event<T>; }
		// Просьба сервера о вводе (MRTR): окно показывает вопрос и отвечает `answerInputRequest`.
		else if (event === 'onInputRequest') { return this._onInputRequest.event as Event<T>; }
		// else if (event === 'onLoading_server') return this.mcpEmitters.serverEvent.onChangeLoading.event;

		// tool call events

		// handle unknown events
		else { throw new Error(`Event not found: ${event}`); }
	}

	// browser uses this to call (see this.channel.call() in electron-browser/mcpService.ts for all usages)
	async call<T>(ctx: string, command: string, params: unknown): Promise<T> {
		try {
			if (command === 'syncMCPServers') {
				await this._syncMCPServers(ctx, params as MCPSyncParams);
				return undefined as T;
			}
			else if (command === 'toggleMCPServer') {
				const p = params as { serverName: string; isOn: boolean };
				await this._toggleMCPServer(p.serverName, p.isOn);
				return undefined as T;
			}
			else if (command === 'answerInputRequest') {
				const p = params as { requestId: string; answer: McpInputAnswer };
				this._resolveInputRequest(p.requestId, p.answer);
				return undefined as T;
			}
			else if (command === 'callTool') {
				const p = params as MCPToolCallParams;
				const response = await this._safeCallTool(p.serverName, p.toolName, p.params);
				return response as T;
			}
			else if (command === 'callToolForApp') {
				const p = params as MCPToolCallParams;
				return await this._appRequest(p.serverName, async client => await client.callTool({ name: p.toolName, arguments: p.params }) as unknown as MCP.CallToolResult) as T;
			}
			else if (command === 'readResource') {
				const p = params as MCPReadResourceParams;
				return await this._appRequest(p.serverName, async client => await client.readResource({ uri: p.uri }) as unknown as MCP.ReadResourceResult) as T;
			}
			else {
				throw new Error(`VibeIDE: command "${command}" not recognized.`);
			}
		}
		catch (e) {
			vibeLog.error('mcpChannel', 'mcp channel: Call Error:', e);
			return undefined as T;
		}
	}

	// server functions


	/** Run one sync or toggle after the ones before it. The queue itself never rejects, so one failure does not block the rest. */
	private _enqueue(operation: () => Promise<void>): Promise<void> {
		const run = this._queue.then(operation);
		this._queue = run.catch(() => { });
		return run;
	}

	private _effectiveAppsEnabled(): boolean {
		for (const enabled of this._appsEnabledOfWindow.values()) {
			if (enabled) {
				return true;
			}
		}
		return false;
	}

	private _knownOf(info: ClientInfo): KnownMCPServer {
		return { fingerprint: info.fingerprint, running: info.client !== undefined };
	}

	/**
	 * A window's whole picture of the servers it wants, brought about against what actually runs. The
	 * window does not say what changed — after a reload it has no idea — only what it wants.
	 */
	private _syncMCPServers(ctx: string, params: MCPSyncParams): Promise<void> {
		this._appsEnabledOfWindow.set(ctx, params.appsEnabled);
		return this._enqueue(async () => {
			const appsEnabled = this._effectiveAppsEnabled();
			const known: Record<string, KnownMCPServer> = {};
			for (const [name, info] of Object.entries(this.infoOfClientId)) {
				known[name] = this._knownOf(info);
			}
			const wanted: Record<string, WantedMCPServer> = {};
			for (const [name, entry] of Object.entries(params.entries)) {
				const isOn = this._isOnOfName.get(name) ?? params.enabledOfName[name] !== false;
				wanted[name] = { fingerprint: mcpServerFingerprint(entry, appsEnabled), isOn };
			}
			const actions = reconcileMCPServers(known, wanted);
			await Promise.allSettled(Object.entries(actions).map(([name, action]) =>
				this._applyAction(name, action, Object.hasOwn(params.entries, name) ? params.entries[name] : undefined, appsEnabled)));
		});
	}

	/** Tell every window a server's state; a server new to them arrives as added. */
	private _fireState(name: string, prevServer: MCPServer | undefined, newServer: MCPServer): void {
		const emitter = prevServer ? this.mcpEmitters.serverEvent.onUpdate : this.mcpEmitters.serverEvent.onAdd;
		emitter.fire({ response: { name, prevServer, newServer } });
	}

	private async _applyAction(name: string, action: MCPServerAction, entry: MCPConfigFileEntryJSON | undefined, appsEnabled: boolean): Promise<void> {
		const info = this.infoOfClientId[name];
		const prevServer = info?.mcpServer;
		if (action === 'remove') {
			await this._closeClient(name);
			delete this.infoOfClientId[name];
			this._isOnOfName.delete(name);
			this.mcpEmitters.serverEvent.onDelete.fire({ response: { name, prevServer } });
			return;
		}
		if (!entry) {
			return;
		}
		if (action === 'keep') {
			// Nothing to launch, but the window that asked — a reloaded one — has not heard the state yet.
			// The entry is taken as sent: what differs is not part of the launch (the tools list, say).
			if (info) {
				info.entry = entry;
				this._fireState(name, prevServer, info.mcpServer);
			}
			return;
		}
		await this._closeClient(name);
		if (action === 'off') {
			const offline: MCPServer = { status: 'offline', tools: [], command: displayCommandOf(entry) };
			this.infoOfClientId[name] = { entry, fingerprint: mcpServerFingerprint(entry, appsEnabled), mcpServer: offline };
			this._fireState(name, prevServer, offline);
			return;
		}
		const loading: MCPServer = { status: 'loading', tools: [] };
		this._fireState(name, prevServer, loading);
		const launched = await this._launch(entry, name, appsEnabled);
		this.infoOfClientId[name] = launched;
		this._fireState(name, loading, launched.mcpServer);
	}

	/** The launches of connected servers, by `mcpServerFingerprint` — what a second entry must not repeat */
	private readonly _activeLaunches = new Map<string, string>();

	/**
	 * VibeIDE: Validate MCP server config before connecting.
	 * Blocks dangerous commands, non-allowlisted remote URLs, and a second entry repeating a running launch.
	 */
	private _validateMCPServer(server: MCPConfigFileEntryJSON, serverName: string): void {
		// Block dangerous shell commands in stdio MCP servers
		const BLOCKED_COMMANDS = ['curl', 'wget', 'powershell', 'cmd', 'bash', 'sh', 'python', 'python3', 'node', 'ruby', 'perl'];
		if (server.command) {
			const cmdBase = server.command.split('/').pop()?.split('\\').pop()?.toLowerCase() ?? '';
			// Only block if the command itself is a shell/downloader without being a known MCP tool
			// For now: warn on potentially dangerous commands but allow (Phase 1)
			// Phase 2: configurable allowlist via .vibe/mcp-allowlist.json
			if (BLOCKED_COMMANDS.includes(cmdBase)) {
				vibeLog.warn('MCP', `⚠️ MCP server "${serverName}" uses a potentially dangerous command: "${server.command}". Ensure this is a trusted MCP server.`);
			}
		}

		// Block non-HTTPS remote URLs (allow localhost and https only)
		if (server.url) {
			const urlStr = typeof server.url === 'string' ? server.url : server.url.toString();
			try {
				const parsed = new URL(urlStr);
				const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
				const isHttps = parsed.protocol === 'https:';
				if (!isLocalhost && !isHttps) {
					throw new Error(`[VibeIDE MCP] Security: MCP server "${serverName}" uses an insecure non-HTTPS URL: "${urlStr}". Only HTTPS or localhost URLs are allowed.`);
				}
			} catch (e) {
				if ((e as Error).message.startsWith('[VibeIDE MCP]')) { throw e; }
				throw new Error(`[VibeIDE MCP] Invalid URL for MCP server "${serverName}": ${urlStr}`);
			}
		}

		// The same launch under two names would run one server twice and offer every tool twice. A shared address is
		// not a duplicate: every team's memory lives at one host, told apart by its header
		const owner = this._activeLaunches.get(mcpServerFingerprint(server, false));
		if (owner !== undefined && owner !== serverName) {
			throw new Error(`[VibeIDE MCP] Сервер «${serverName}» повторяет запуск сервера «${owner}» — один сервер работал бы дважды. Оставьте одну из записей.`);
		}
	}

	private _registerActiveLaunch(server: MCPConfigFileEntryJSON, serverName: string): void {
		this._activeLaunches.set(mcpServerFingerprint(server, false), serverName);
	}

	private _unregisterActiveLaunch(server: MCPConfigFileEntryJSON, serverName: string): void {
		const key = mcpServerFingerprint(server, false);
		if (this._activeLaunches.get(key) === serverName) {
			this._activeLaunches.delete(key);
		}
	}

	/**
	 * The headers of an HTTP server: the entry's own, then what its `headersHelper` prints, run without a shell
	 * The output may be a token, so neither it nor the helper's stderr reaches an error message or the log
	 */
	private async _headersOf(server: MCPConfigFileEntryJSON, serverName: string): Promise<Record<string, string> | undefined> {
		const helper = server.headersHelper;
		if (!helper) {
			return server.headers;
		}
		const { execFile } = await import('child_process');
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(helper.command, helper.args ?? [], { timeout: HEADERS_HELPER_TIMEOUT_MS, windowsHide: true, maxBuffer: HEADERS_HELPER_MAX_OUTPUT }, (err, out) => {
				if (err) {
					const why = err.killed ? 'не уложился в срок' : `завершился с кодом ${err.code ?? 'неизвестно'}`;
					reject(new Error(`[VibeIDE MCP] Помощник заголовков сервера «${serverName}» ${why}`));
					return;
				}
				resolve(String(out));
			});
		});
		const headers = helperHeadersOf(stdout);
		if (!headers) {
			throw new Error(`[VibeIDE MCP] Помощник заголовков сервера «${serverName}» напечатал не JSON-объект строк`);
		}
		return { ...(server.headers ?? {}), ...headers };
	}

	private async _createClientUnsafe(server: MCPConfigFileEntryJSON, serverName: string, appsEnabled: boolean): Promise<{ client: import('@modelcontextprotocol/sdk/client/index.js').Client; mcpServer: MCPServerNonError }> {

		// VibeIDE: Validate server config before connecting
		this._validateMCPServer(server, serverName);

		// Lazy-load the heavy MCP SDK modules only when a client is actually created.
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
		const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
		const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

		const clientConfig = getClientConfig(serverName);
		const client = new Client(clientConfig, { capabilities: mcpAppsClientCapabilities(appsEnabled) });
		let transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
		let info: MCPServerNonError;

		try {
			if (server.url) {
				// Normalize URL to URL object (MCP SDK transports accept URL objects)
				let url: URL;
				try {
					url = typeof server.url === 'string' ? new URL(server.url) : server.url;
				} catch (urlErr) {
					throw new Error(`Invalid URL for server ${serverName}: ${server.url}. ${urlErr instanceof Error ? urlErr.message : String(urlErr)}`);
				}
				const urlString = url.toString();
				const headers = await this._headersOf(server, serverName);
				// Determine transport type: explicit type, or infer from URL path
				let transportType = server.type;
				// If no explicit type, check if URL path suggests SSE (e.g., contains '/sse')
				if (!transportType && urlString.toLowerCase().includes('/sse')) {
					transportType = 'sse';
				}

				// If type is explicitly 'sse' or inferred as SSE, use SSE directly
				if (transportType === 'sse') {
					try {
						transport = new SSEClientTransport(url, transportRequestInit(headers));
						await client.connect(transport);
						vibeLog.info('mcpChannel', `Connected via SSE to ${serverName}`);
						const { tools } = await this._listTools(client, serverName);
						info = {
							status: 'success',
							tools: tools,
							command: urlString,
						};
					} catch (sseErr) {
						throw new Error(`Failed to connect to SSE server at ${urlString}: ${sseErr instanceof Error ? sseErr.message : String(sseErr)}`);
					}
				}
				// If type is explicitly 'http', only try HTTP
				else if (transportType === 'http') {
					try {
						transport = new StreamableHTTPClientTransport(url, transportRequestInit(headers));
						await client.connect(transport);
						vibeLog.info('mcpChannel', `Connected via HTTP to ${serverName}`);
						const { tools } = await this._listTools(client, serverName);
						info = {
							status: 'success',
							tools: tools,
							command: urlString,
						};
					} catch (httpErr) {
						throw new Error(`Failed to connect to HTTP server at ${urlString}: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`);
					}
				}
				// If type is not specified, try HTTP first, fall back to SSE
				else {
					try {
						transport = new StreamableHTTPClientTransport(url, transportRequestInit(headers));
						await client.connect(transport);
						vibeLog.info('mcpChannel', `Connected via HTTP to ${serverName}`);
						const { tools } = await this._listTools(client, serverName);
						info = {
							status: 'success',
							tools: tools,
							command: urlString,
						};
					} catch (httpErr) {
						vibeLog.warn('mcpChannel', `HTTP failed for ${serverName}, trying SSE…`, httpErr);
						transport = new SSEClientTransport(url, transportRequestInit(headers));
						await client.connect(transport);
						const { tools } = await this._listTools(client, serverName);
						vibeLog.info('mcpChannel', `Connected via SSE to ${serverName}`);
						info = {
							status: 'success',
							tools: tools,
							command: urlString,
						};
					}
				}
			} else if (server.command) {
				// The entry wins over the IDE environment; critical names from the entry never apply.
				// See common/mcpServerEnv.ts for why both halves of that sentence matter.
				const { env: mergedEnv, ignored } = mergeServerEnv(process.env, server.env);
				if (ignored.length > 0) {
					vibeLog.warn('MCP', `MCP server "${serverName}": variables not applied from mcp.json (critical, would override the IDE environment): ${ignored.join(', ')}`);
				}
				transport = new StdioClientTransport({
					command: server.command,
					args: server.args,
					env: mergedEnv,
					...(server.cwd ? { cwd: server.cwd } : {}),
				});

				await client.connect(transport);

				// Get the tools from the server
				const { tools } = await this._listTools(client, serverName);

				// Create a full command string for display
				const fullCommand = `${server.command} ${server.args?.join(' ') || ''}`;

				// Format server object
				info = {
					status: 'success',
					tools: tools,
					command: fullCommand,
				};

			} else {
				throw new Error(`No url or command for server ${serverName}`);
			}
		} catch (err) {
			// The process may be up although connecting or listing tools failed. Closing the client ends it;
			// without that every failed start left one behind.
			await client.close().catch(() => { });
			throw err;
		}

		return { client, mcpServer: info };
	}

	/**
	 * Список инструментов плюс срок его годности, если сервер его объявил.
	 *
	 * Мы список не опрашиваем — читаем при подключении и держим до ручного обновления. Поэтому срок
	 * годности здесь не экономия запросов, а единственный способ узнать, что список устарел: сервер
	 * сам говорит, до какого момента ему верить, и по истечении мы перечитываем ровно его.
	 */
	private async _listTools(client: import('@modelcontextprotocol/sdk/client/index.js').Client, serverName: string): Promise<{ tools: MCPTool[] }> {
		await this._watchToolListChanges(client, serverName);
		const listed = await client.listTools();
		const meta = parseCacheableMeta(listed);
		this._scheduleToolListRefresh(serverName, meta);
		// Аннотация `x-mcp-header` приходит от сервера и уезжает в HTTP: негодное имя заголовка —
		// это внедрение чужого заголовка, поэтому такой инструмент исключается из списка, а не
		// «исправляется». Остальные инструменты сервера при этом продолжают работать.
		const { tools, rejected } = filterToolsWithValidHeaders(listed.tools as MCPTool[]);
		for (const item of rejected) {
			vibeLog.warn('mcpChannel', `MCP server "${serverName}": инструмент «${item.name}» отвергнут — ${item.reason}`);
		}
		return { tools };
	}

	/**
	 * Re-read the list the moment the server says it changed (`notifications/tools/list_changed`), so a
	 * tool changed after approval is checked against its pin now rather than at the next start. Only a
	 * server that declared `tools.listChanged` sends it; for the rest a declared cache lifetime is still
	 * the only signal. Setting the handler again on every re-read is harmless: it replaces itself.
	 */
	private async _watchToolListChanges(client: import('@modelcontextprotocol/sdk/client/index.js').Client, serverName: string): Promise<void> {
		if (!client.getServerCapabilities()?.tools?.listChanged) {
			return;
		}
		const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
		client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
			vibeLog.info('mcpChannel', `MCP server "${serverName}": сервер сообщил об изменении списка инструментов — перечитываю`);
			void this._rereadToolList(serverName);
		});
	}

	/** Перечитать список этого сервера, когда объявленный им срок истечёт. */
	private _scheduleToolListRefresh(serverName: string, meta: McpCacheableMeta | undefined): void {
		const existing = this._toolListTimers.get(serverName);
		if (existing) {
			clearTimeout(existing);
			this._toolListTimers.delete(serverName);
		}
		if (!meta) {
			return;
		}
		const delay = refreshDelayMs(meta);
		vibeLog.info('mcpChannel', `MCP server "${serverName}": список инструментов годен ${meta.ttlMs} мс${meta.cacheScope ? ` (${meta.cacheScope})` : ''} — перечитаю через ${delay} мс`);
		this._toolListTimers.set(serverName, setTimeout(() => {
			this._toolListTimers.delete(serverName);
			void this._rereadToolList(serverName);
		}, delay));
	}

	private async _rereadToolList(serverName: string): Promise<void> {
		const info = this.infoOfClientId[serverName];
		const client = info?.client;
		if (!client || info.mcpServer.status !== 'success') {
			return;
		}
		try {
			const prevServer = info.mcpServer;
			const { tools } = await this._listTools(client, serverName);
			// A restart during the read replaced the client: its answer describes a client that no longer runs.
			if (this.infoOfClientId[serverName] !== info || info.client !== client) {
				return;
			}
			// Собирается полем к полю, а не спредом: `MCPServerNonError` — пересечение с `Omit<…>`, и
			// спред по нему теряет сужение статуса.
			const newServer: MCPServer = {
				status: prevServer.status === 'loading' || prevServer.status === 'offline' ? prevServer.status : 'success',
				tools,
				...(prevServer.command !== undefined ? { command: prevServer.command } : {}),
				...(prevServer.error !== undefined ? { error: prevServer.error } : {}),
			};
			info.mcpServer = newServer;
			this.mcpEmitters.serverEvent.onUpdate.fire({ response: { name: serverName, newServer, prevServer } });
		} catch (err) {
			// Протухший список лучше молчаливой ошибки: оставляем прежний и говорим об этом в журнал.
			vibeLog.warn('mcpChannel', `MCP server "${serverName}": не удалось перечитать список инструментов по истечении срока`, err);
		}
	}

	/** Start a server; a failure becomes the server's error state rather than a thrown error. */
	private async _launch(entry: MCPConfigFileEntryJSON, serverName: string, appsEnabled: boolean): Promise<ClientInfo> {
		const fingerprint = mcpServerFingerprint(entry, appsEnabled);
		try {
			const { client, mcpServer } = await this._createClientUnsafe(entry, serverName, appsEnabled);
			this._registerActiveLaunch(entry, serverName);
			return { entry, fingerprint, client, mcpServer };
		} catch (err) {
			vibeLog.error('mcpChannel', `❌ Failed to connect to server "${serverName}":`, err);
			// Отказ из-за ревизии протокола приходит из недр SDK английской строкой, по которой не понять
			// ни причины, ни что делать. Случай настоящий: сервер ревизии 2026-07-28 отвергается на рукопожатии.
			const mismatch = describeProtocolMismatch(err);
			// A 401 to a helper's header is a revoked token, and the fix is where the token is issued
			const unauthorized = entry.headersHelper ? describeUnauthorizedHelper(serverName, err) : undefined;
			const failed: MCPServerError = { status: 'error', error: mismatch ?? unauthorized ?? (err + ''), command: displayCommandOf(entry) };
			return { entry, fingerprint, mcpServer: failed };
		}
	}

	/** Close every client, bounded in time: quitting must not hang on a server that does not answer. */
	private async _closeAllClients(): Promise<void> {
		const closing = Promise.allSettled(Object.keys(this.infoOfClientId).map(serverName => this._closeClient(serverName)));
		await raceTimeout(closing, CLOSE_ON_SHUTDOWN_TIMEOUT_MS);
	}

	/** Stop the server's client, if it runs; the server stays listed — the caller decides what it becomes. */
	private async _closeClient(serverName: string) {
		const timer = this._toolListTimers.get(serverName);
		if (timer) {
			clearTimeout(timer);
			this._toolListTimers.delete(serverName);
		}
		const info = this.infoOfClientId[serverName];
		const client = info?.client;
		if (!client) {
			return;
		}
		info.client = undefined;
		try {
			await client.close();
		} catch (err) {
			vibeLog.warn('mcpChannel', `MCP server "${serverName}": closing the client failed`, err);
		}
		this._unregisterActiveLaunch(info.entry, serverName);
		vibeLog.info('mcpChannel', `Closed MCP server ${serverName}`);
	}

	/**
	 * Switch one server on or off: the same reconciliation as a sync, for this server only. Switching on a
	 * running server changes nothing; switching on one that failed tries it again.
	 */
	private _toggleMCPServer(serverName: string, isOn: boolean): Promise<void> {
		this._isOnOfName.set(serverName, isOn);
		return this._enqueue(async () => {
			const info = this.infoOfClientId[serverName];
			if (!info) {
				return;
			}
			const appsEnabled = this._effectiveAppsEnabled();
			const actions = reconcileMCPServers(
				{ [serverName]: this._knownOf(info) },
				{ [serverName]: { fingerprint: mcpServerFingerprint(info.entry, appsEnabled), isOn } },
			);
			await this._applyAction(serverName, actions[serverName], info.entry, appsEnabled);
		});
	}

	// tool call functions

	private async _callTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const server = this.infoOfClientId[serverName];
		if (!server) {
			throw new Error(`Server ${serverName} not found`);
		}
		const client = server.client;
		if (!client) {
			throw new Error(`MCP server ${serverName} is not running — switched off or failed to start`);
		}

		// Call the tool with the provided parameters. `toolName` arrives here as the
		// bare name (caller passes mcpTool.originalName via chatThreadService), so no
		// stripping is needed — pass straight through to the MCP server.
		// Конверт MRTR — не результат инструмента: в нём нет ни content, ни structuredContent. Сервер задал вопрос —
		// спрашиваем человека и повторяем тот же вызов с ответами (SEP-2322). Модель в этом не участвует:
		// вопрос адресован человеку, и пересказывать его моделью значило бы платить за ход и портить формулировку.
		let callParams = params;
		let response = await client.callTool({ name: toolName, arguments: callParams });
		for (let round = 0; round < MAX_INPUT_ROUNDS; round++) {
			const inputRequired = parseInputRequired(response);
			if (!inputRequired) { break; }
			const methods = inputRequired.inputRequests.map(r => r.method).join(', ') || '(метод не назван)';
			vibeLog.info('mcpChannel', `MCP server "${serverName}": инструмент ${toolName} просит ввод — ${methods} (круг ${round + 1})`);

			const plan = planInputRequests(inputRequired.inputRequests);
			// Хоть одна просьба, на которую мы не умеем ответить, — и повтор всё равно не состоится.
			// Спрашивать человека ради заведомо неполного ответа значит тратить его время заранее впустую.
			if (plan.unsupported.length > 0) {
				vibeLog.warn('mcpChannel', `MCP server "${serverName}": не умеем отвечать на ${plan.unsupported.join(', ')}`);
				throw new Error(describeUnansweredInput(toolName, inputRequired));
			}

			const requestId = `mcp-input-${++this._inputRequestSeq}`;
			const ask: McpInputAsk = {
				requestId,
				serverName,
				toolName,
				elicitations: plan.elicitations.map(item => ({ key: item.request.key, form: item.form })),
				rootKeys: plan.roots.map(request => request.key),
			};
			const answer = await this._askWindowForInput(ask);
			if (!answer.ok) {
				throw new Error(`Инструмент «${toolName}» не выполнен: сервер просил ввод, но ${answer.reason}.`);
			}
			// `requestState` уезжает дословно и с ДРУГИМ id запроса — это требование спеки; новый id даёт сам SDK.
			callParams = withInputResponses(callParams, answer.responses, inputRequired.requestState);
			response = await client.callTool({ name: toolName, arguments: callParams });
		}
		// Круги кончились, а сервер всё просит: продолжать значило бы держать человека в бесконечном допросе.
		const stillAsking = parseInputRequired(response);
		if (stillAsking) {
			throw new Error(`Инструмент «${toolName}» не выполнен: сервер продолжает просить ввод после ${MAX_INPUT_ROUNDS} кругов ответов.`);
		}

		const { content, structuredContent } = response as import('@modelcontextprotocol/sdk/types.js').CallToolResult;
		// Kept whole for an MCP App rendering this result; the model still gets the text below.
		const callResult = response as unknown as MCP.CallToolResult;
		const returnValue = content[0];

		// App tools often answer with structured content alone; its JSON is the text the model sees.
		if (!returnValue && structuredContent) {
			if (response.isError) {
				throw new Error(`Tool call error: ${JSON.stringify(structuredContent)}`);
			}
			return { event: 'text', text: JSON.stringify(structuredContent), toolName, serverName, callResult };
		}

		if (returnValue?.type === 'text') {
			// handle text response

			if (response.isError) {
				throw new Error(`Tool call error: ${returnValue.text}`);
			}

			// handle success
			return {
				event: 'text',
				text: returnValue.text,
				toolName,
				serverName,
				callResult,
			};
		}

		// if (returnValue.type === 'audio') {
		// 	// handle audio response
		// }

		// if (returnValue.type === 'image') {
		// 	// handle image response
		// }

		// if (returnValue.type === 'resource') {
		// 	// handle resource response
		// }

		throw new Error(`Tool call error: We don\'t support ${returnValue?.type ?? 'empty'} tool response yet for tool ${toolName} on server ${serverName}`);
	}

	/** A request an MCP App makes through the host; failures come back as data, never as a dropped `undefined`. */
	private async _appRequest<T>(serverName: string, run: (client: import('@modelcontextprotocol/sdk/client/index.js').Client) => Promise<T>): Promise<MCPAppRequestOutcome<T>> {
		const client = this.infoOfClientId[serverName]?.client;
		if (!client) {
			return { ok: false, error: `Server ${serverName} is not connected` };
		}
		try {
			return { ok: true, value: await run(client) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}

	// tool call error wrapper
	private async _safeCallTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<RawMCPToolCall> {
		try {
			const response = await this._callTool(serverName, toolName, params);
			return response;
		} catch (err) {

			let errorMessage: string;

			if (typeof err === 'object' && err !== null && err['code']) {
				const code = err.code;
				let codeDescription = '';
				if (code === -32700) {
					codeDescription = 'Parse Error';
				}
				if (code === -32600) {
					codeDescription = 'Invalid Request';
				}
				if (code === -32601) {
					codeDescription = 'Method Not Found';
				}
				if (code === -32602) {
					codeDescription = 'Invalid Parameters';
				}
				if (code === -32603) {
					codeDescription = 'Internal Error';
				}
				errorMessage = `${codeDescription}. Full response:\n${JSON.stringify(err, null, 2)}`;
			}
			// Check if it's an MCP error with a code
			else if (typeof err === 'string') {
				// String error
				errorMessage = err;
			} else {
				// Unknown error format
				errorMessage = JSON.stringify(err, null, 2);
			}

			const fullErrorMessage = `❌ Failed to call tool "${toolName}" on server "${serverName}": ${errorMessage}`;
			const errorResponse: MCPToolErrorResponse = {
				event: 'error',
				text: fullErrorMessage,
				toolName,
				serverName,
			};
			return errorResponse;
		}
	}
}


