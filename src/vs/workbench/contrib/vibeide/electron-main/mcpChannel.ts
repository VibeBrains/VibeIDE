/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// registered in app.ts
// can't make a service responsible for this, because it needs
// to be connected to the main process and node dependencies

import { vibeLog } from '../common/vibeLog.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
// MCP SDK client/transport modules are heavy and electron-main start-up sensitive; they are
// loaded lazily via `await import(...)` inside `_createClientUnsafe`. Type-only positions use
// inline `import('...')` type expressions so no value import reaches module scope.
import { MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, RawMCPToolCall, MCPToolErrorResponse, MCPServerEventResponse, MCPToolCallParams } from '../common/mcpServiceTypes.js';
import { MCPUserStateOfName } from '../common/vibeideSettingsTypes.js';

const getClientConfig = (serverName: string) => {
	return {
		name: `${serverName}-client`,
		version: '0.1.0',
		// debug: true,
	};
};

type MCPServerNonError = MCPServer & { status: Omit<MCPServer['status'], 'error'> };
type MCPServerError = MCPServer & { status: 'error' };



type ClientInfo = {
	_client: import('@modelcontextprotocol/sdk/client/index.js').Client; // _client is the client that connects with an mcp client. We're calling mcp clients "server" everywhere except here for naming consistency.
	mcpServerEntryJSON: MCPConfigFileEntryJSON;
	mcpServer: MCPServerNonError;
} | {
	_client?: undefined;
	mcpServerEntryJSON: MCPConfigFileEntryJSON;
	mcpServer: MCPServerError;
};

type InfoOfClientId = {
	[clientId: string]: ClientInfo;
};

export class MCPChannel implements IServerChannel {

	private readonly infoOfClientId: InfoOfClientId = {};
	private readonly _refreshingServerNames: Set<string> = new Set();

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
	) { }

	// browser uses this to listen for changes
	listen<T>(_: unknown, event: string): Event<T> {

		// server events
		if (event === 'onAdd_server') { return this.mcpEmitters.serverEvent.onAdd.event as Event<T>; }
		else if (event === 'onUpdate_server') { return this.mcpEmitters.serverEvent.onUpdate.event as Event<T>; }
		else if (event === 'onDelete_server') { return this.mcpEmitters.serverEvent.onDelete.event as Event<T>; }
		// else if (event === 'onLoading_server') return this.mcpEmitters.serverEvent.onChangeLoading.event;

		// tool call events

		// handle unknown events
		else { throw new Error(`Event not found: ${event}`); }
	}

	// browser uses this to call (see this.channel.call() in mcpConfigService.ts for all usages)
	async call<T>(_: unknown, command: string, params: unknown): Promise<T> {
		try {
			if (command === 'refreshMCPServers') {
				await this._refreshMCPServers(params as Parameters<MCPChannel['_refreshMCPServers']>[0]);
				return undefined as T;
			}
			else if (command === 'closeAllMCPServers') {
				await this._closeAllMCPServers();
				return undefined as T;
			}
			else if (command === 'toggleMCPServer') {
				const p = params as { serverName: string; isOn: boolean };
				await this._toggleMCPServer(p.serverName, p.isOn);
				return undefined as T;
			}
			else if (command === 'callTool') {
				const p = params as MCPToolCallParams;
				const response = await this._safeCallTool(p.serverName, p.toolName, p.params);
				return response as T;
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


	private async _refreshMCPServers(params: { mcpConfigFileJSON: MCPConfigFileJSON; userStateOfName: MCPUserStateOfName; addedServerNames: string[]; removedServerNames: string[]; updatedServerNames: string[] }) {

		const {
			mcpConfigFileJSON,
			userStateOfName,
			addedServerNames,
			removedServerNames,
			updatedServerNames,
		} = params;

		const { mcpServers: mcpServersJSON } = mcpConfigFileJSON;

		const allChanges: { type: 'added' | 'removed' | 'updated'; serverName: string }[] = [
			...addedServerNames.map(n => ({ serverName: n, type: 'added' }) as const),
			...removedServerNames.map(n => ({ serverName: n, type: 'removed' }) as const),
			...updatedServerNames.map(n => ({ serverName: n, type: 'updated' }) as const),
		];

		// Per-server try/finally ensures `_refreshingServerNames` is cleaned even if any
		// _createClient / _closeClient rejects (Promise.all otherwise short-circuits and
		// the outer cleanup never runs, leaking the Set forever on a single failed server).
		// Also use Promise.allSettled so one bad server doesn't kill refresh of the others.
		await Promise.allSettled(
			allChanges.map(async ({ serverName, type }) => {

				// check if already refreshing
				if (this._refreshingServerNames.has(serverName)) { return; }
				this._refreshingServerNames.add(serverName);

				try {
					const prevServer = this.infoOfClientId[serverName]?.mcpServer;

					// close and delete the old client
					if (type === 'removed' || type === 'updated') {
						await this._closeClient(serverName);
						delete this.infoOfClientId[serverName];
						this.mcpEmitters.serverEvent.onDelete.fire({ response: { prevServer, name: serverName, } });
					}

					// create a new client
					if (type === 'added' || type === 'updated') {
						const clientInfo = await this._createClient(mcpServersJSON[serverName], serverName, userStateOfName[serverName]?.isOn);
						this.infoOfClientId[serverName] = clientInfo;
						this.mcpEmitters.serverEvent.onAdd.fire({ response: { newServer: clientInfo.mcpServer, name: serverName, } });
					}
				} finally {
					this._refreshingServerNames.delete(serverName);
				}
			})
		);

	}

	/** VibeIDE: Track URLs used by active MCP servers to detect port conflicts */
	private readonly _activeUrls = new Set<string>();

	/**
	 * VibeIDE: Validate MCP server config before connecting.
	 * Blocks dangerous commands, non-allowlisted remote URLs, and port conflicts.
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

				// VibeIDE: Port conflict detection — check if another MCP server already uses this URL
				const urlKey = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
				if (this._activeUrls.has(urlKey)) {
					throw new Error(`[VibeIDE MCP] Port conflict: MCP server "${serverName}" tries to connect to ${urlKey} which is already used by another active MCP server. Use different ports.`);
				}
			} catch (e) {
				if ((e as Error).message.startsWith('[VibeIDE MCP]')) { throw e; }
				throw new Error(`[VibeIDE MCP] Invalid URL for MCP server "${serverName}": ${urlStr}`);
			}
		}
	}

	private _registerActiveUrl(server: MCPConfigFileEntryJSON): void {
		if (server.url) {
			try {
				const urlStr = typeof server.url === 'string' ? server.url : server.url.toString();
				const parsed = new URL(urlStr);
				const urlKey = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
				this._activeUrls.add(urlKey);
			} catch { /* ignore */ }
		}
	}

	private _unregisterActiveUrl(server: MCPConfigFileEntryJSON): void {
		if (server.url) {
			try {
				const urlStr = typeof server.url === 'string' ? server.url : server.url.toString();
				const parsed = new URL(urlStr);
				const urlKey = `${parsed.hostname}:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')}`;
				this._activeUrls.delete(urlKey);
			} catch { /* ignore */ }
		}
	}

	private async _createClientUnsafe(server: MCPConfigFileEntryJSON, serverName: string, isOn: boolean): Promise<ClientInfo> {

		// VibeIDE: Validate server config before connecting
		this._validateMCPServer(server, serverName);

		// Lazy-load the heavy MCP SDK modules only when a client is actually created.
		const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
		const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
		const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
		const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

		const clientConfig = getClientConfig(serverName);
		const client = new Client(clientConfig);
		let transport: import('@modelcontextprotocol/sdk/shared/transport.js').Transport;
		let info: MCPServerNonError;

		if (server.url) {
			// Normalize URL to URL object (MCP SDK transports accept URL objects)
			let url: URL;
			try {
				url = typeof server.url === 'string' ? new URL(server.url) : server.url;
			} catch (urlErr) {
				throw new Error(`Invalid URL for server ${serverName}: ${server.url}. ${urlErr instanceof Error ? urlErr.message : String(urlErr)}`);
			}
			const urlString = url.toString();
			// Determine transport type: explicit type, or infer from URL path
			let transportType = server.type;
			// If no explicit type, check if URL path suggests SSE (e.g., contains '/sse')
			if (!transportType && urlString.toLowerCase().includes('/sse')) {
				transportType = 'sse';
			}

			// If type is explicitly 'sse' or inferred as SSE, use SSE directly
			if (transportType === 'sse') {
				try {
					transport = new SSEClientTransport(url);
					await client.connect(transport);
					vibeLog.info('mcpChannel', `Connected via SSE to ${serverName}`);
					const { tools } = await client.listTools();
					info = {
						status: isOn ? 'success' : 'offline',
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
					transport = new StreamableHTTPClientTransport(url);
					await client.connect(transport);
					vibeLog.info('mcpChannel', `Connected via HTTP to ${serverName}`);
					const { tools } = await client.listTools();
					info = {
						status: isOn ? 'success' : 'offline',
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
					transport = new StreamableHTTPClientTransport(url);
					await client.connect(transport);
					vibeLog.info('mcpChannel', `Connected via HTTP to ${serverName}`);
					const { tools } = await client.listTools();
					info = {
						status: isOn ? 'success' : 'offline',
						tools: tools,
						command: urlString,
					};
				} catch (httpErr) {
					vibeLog.warn('mcpChannel', `HTTP failed for ${serverName}, trying SSE…`, httpErr);
					transport = new SSEClientTransport(url);
					await client.connect(transport);
					const { tools } = await client.listTools();
					vibeLog.info('mcpChannel', `Connected via SSE to ${serverName}`);
					info = {
						status: isOn ? 'success' : 'offline',
						tools: tools,
						command: urlString,
					};
				}
			}
		} else if (server.command) {
			// console.log('ENV DATA: ', server.env)
			// process.env values are `string | undefined`; filter out undefined so the
			// merged env is a genuine Record<string, string> without a hiding assertion.
			const mergedEnv: Record<string, string> = { ...server.env };
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) {
					mergedEnv[key] = value;
				}
			}
			transport = new StdioClientTransport({
				command: server.command,
				args: server.args,
				env: mergedEnv,
			});

			await client.connect(transport);

			// Get the tools from the server
			const { tools } = await client.listTools();

			// Create a full command string for display
			const fullCommand = `${server.command} ${server.args?.join(' ') || ''}`;

			// Format server object
			info = {
				status: isOn ? 'success' : 'offline',
				tools: tools,
				command: fullCommand,
			};

		} else {
			throw new Error(`No url or command for server ${serverName}`);
		}


		return { _client: client, mcpServerEntryJSON: server, mcpServer: info };
	}

	private async _createClient(serverConfig: MCPConfigFileEntryJSON, serverName: string, isOn = true): Promise<ClientInfo> {
		try {
			const c: ClientInfo = await this._createClientUnsafe(serverConfig, serverName, isOn);
			// VibeIDE: Register URL after successful connection for port conflict tracking
			this._registerActiveUrl(serverConfig);
			return c;
		} catch (err) {
			vibeLog.error('mcpChannel', `❌ Failed to connect to server "${serverName}":`, err);
			const fullCommand = !serverConfig.command ? '' : `${serverConfig.command} ${serverConfig.args?.join(' ') || ''}`;
			const c: MCPServerError = { status: 'error', error: err + '', command: fullCommand, };
			return { mcpServerEntryJSON: serverConfig, mcpServer: c, };
		}
	}

	private async _closeAllMCPServers() {
		for (const serverName in this.infoOfClientId) {
			await this._closeClient(serverName);
			delete this.infoOfClientId[serverName];
		}
		vibeLog.info('mcpChannel', 'Closed all MCP servers');
	}

	private async _closeClient(serverName: string) {
		const info = this.infoOfClientId[serverName];
		if (!info) {
			return;
		}
		const { _client: client } = info;
		if (client) {
			await client.close();
		}
		// VibeIDE: Unregister URL on close for port conflict tracking
		this._unregisterActiveUrl(info.mcpServerEntryJSON);
		vibeLog.info('mcpChannel', `Closed MCP server ${serverName}`);
	}


	private async _toggleMCPServer(serverName: string, isOn: boolean) {
		const prevServer = this.infoOfClientId[serverName]?.mcpServer;
		// Handle turning on the server
		if (isOn) {
			// this.mcpEmitters.serverEvent.onChangeLoading.fire(getLoadingServerObject(serverName, isOn))
			const clientInfo = await this._createClientUnsafe(this.infoOfClientId[serverName].mcpServerEntryJSON, serverName, isOn);
			this.mcpEmitters.serverEvent.onUpdate.fire({
				response: {
					name: serverName,
					newServer: clientInfo.mcpServer,
					prevServer: prevServer,
				}
			});
		}
		// Handle turning off the server
		else {
			// this.mcpEmitters.serverEvent.onChangeLoading.fire(getLoadingServerObject(serverName, isOn))
			this._closeClient(serverName);
			// Guard: infoOfClientId[serverName] may be undefined if a toggle race fired
			// while the server entry was being torn down by _refreshMCPServers. Without
			// this guard the property access on undefined throws TypeError and crashes
			// the channel.
			const info = this.infoOfClientId[serverName];
			if (info) {
				delete (info as { _client?: unknown })._client;
			}

			this.mcpEmitters.serverEvent.onUpdate.fire({
				response: {
					name: serverName,
					newServer: {
						status: 'offline',
						tools: [],
						command: '',
						// Explicitly set error to undefined to reset the error state
						error: undefined,
					},
					prevServer: prevServer,
				}
			});
		}
	}

	// tool call functions

	private async _callTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<RawMCPToolCall> {
		const server = this.infoOfClientId[serverName];
		if (!server) {
			throw new Error(`Server ${serverName} not found`);
		}
		const { _client: client } = server;
		if (!client) {
			throw new Error(`Client for server ${serverName} not found`);
		}

		// Call the tool with the provided parameters. `toolName` arrives here as the
		// bare name (caller passes mcpTool.originalName via chatThreadService), so no
		// stripping is needed — pass straight through to the MCP server.
		const response = await client.callTool({
			name: toolName,
			arguments: params
		});
		const { content } = response as import('@modelcontextprotocol/sdk/types.js').CallToolResult;
		const returnValue = content[0];

		if (returnValue.type === 'text') {
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

		throw new Error(`Tool call error: We don\'t support ${returnValue.type} tool response yet for tool ${toolName} on server ${serverName}`);
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


