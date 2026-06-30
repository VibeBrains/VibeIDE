/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { MCPServerOfName, MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, MCPToolCallParams, RawMCPToolCall, MCPServerEventResponse } from './mcpServiceTypes.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { InternalToolInfo } from './prompt/prompts.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { MCPUserStateOfName } from './vibeideSettingsTypes.js';
import { IVibeOutboundRingBuffer } from './vibeOutboundRingBuffer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { scanMcpConfig, ConfigGuardFinding } from './vibeConfigGuard.js';


type MCPServiceState = {
	mcpServerOfName: MCPServerOfName;
	error: string | undefined; // global parsing error
};

export interface IMCPService {
	readonly _serviceBrand: undefined;
	revealMCPConfigFile(): Promise<void>;
	toggleServerIsOn(serverName: string, isOn: boolean): Promise<void>;

	readonly state: MCPServiceState; // NOT persisted
	onDidChangeState: Event<void>;

	getMCPTools(): InternalToolInfo[] | undefined;
	callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }>;
	stringifyResult(result: RawMCPToolCall): string;

	/** Config Guard findings from the last load of `mcp.json` (empty if disabled/clean). */
	getLastGuardFindings(): readonly ConfigGuardFinding[];
}

export const IMCPService = createDecorator<IMCPService>('mcpConfigService');



const MCP_CONFIG_FILE_NAME = 'mcp.json';
const MCP_CONFIG_SAMPLE = { mcpServers: {} };
const MCP_CONFIG_SAMPLE_STRING = JSON.stringify(MCP_CONFIG_SAMPLE, null, 2);

/**
 * Reduce an arbitrary string to the character set that downstream tool-calling
 * adapters accept for tool names: `[a-zA-Z0-9_-]`. Spaces, slashes, dots and
 * unicode are folded to underscores. Matches Kilo's `sanitize` in
 * packages/opencode/src/mcp/index.ts.
 */
const sanitizeMcpIdentifier = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');


// export interface MCPCallToolOfToolName {
// 	[toolName: string]: (params: any) => Promise<{
// 		result: any | Promise<any>,
// 		interruptTool?: () => void
// 	}>;
// }


class MCPService extends Disposable implements IMCPService {
	_serviceBrand: undefined;


	private readonly channel: IChannel; // MCPChannel

	// list of MCP servers pulled from mcpChannel
	state: MCPServiceState = {
		mcpServerOfName: {},
		error: undefined,
	};

	// Emitters for server events
	private readonly _onDidChangeState = new Emitter<void>();
	public readonly onDidChangeState = this._onDidChangeState.event;

	/** Config Guard finding signature of the last refresh — dedupes the user notification across re-reads. */
	private _lastGuardSig = '';
	/** Config Guard findings from the last refresh — surfaced by the diagnostic command. */
	private _lastGuardFindings: readonly ConfigGuardFinding[] = [];

	private readonly _scheduleMcpConfigRefresh = this._register(new RunOnceScheduler(() => {
		void this._refreshMCPServers();
	}, 350));

	// private readonly _onLoadingServersChange = new Emitter<MCPServerEventLoadingParam>();
	// public readonly onLoadingServersChange = this._onLoadingServersChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IProductService private readonly productService: IProductService,
		@IEditorService private readonly editorService: IEditorService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@IVibeOutboundRingBuffer private readonly _outboundBuffer: IVibeOutboundRingBuffer,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this.channel = this.mainProcessService.getChannel('vibe-channel-mcp');


		const onEvent = (e: MCPServerEventResponse) => {
			// console.log('GOT EVENT', e)
			this._setMCPServerState(e.response.name, e.response.newServer);
		};
		this._register((this.channel.listen('onAdd_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onUpdate_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onDelete_server') satisfies Event<MCPServerEventResponse>)(onEvent));

		this._initialize();
	}


	private async _initialize() {
		try {
			await this.vibeideSettingsService.waitForInitState;

			// Create .mcpConfig if it doesn't exist
			const mcpConfigUri = await this._getMCPConfigFilePath();
			const fileExists = await this._configFileExists(mcpConfigUri);
			if (!fileExists) {
				await this._createMCPConfigFile(mcpConfigUri);
				vibeLog.info('mcp', 'MCP Config file created:', mcpConfigUri.toString());
			}
			await this._addMCPConfigFileWatcher();
			await this._refreshMCPServers();
		} catch (error) {
			vibeLog.error('mcp', 'Error initializing MCPService:', error);
		}
	}

	private readonly _setMCPServerState = async (serverName: string, newServer: MCPServer | undefined) => {
		if (newServer === undefined) {
			// Remove the server from the state
			const { [serverName]: removed, ...remainingServers } = this.state.mcpServerOfName;
			this.state = {
				...this.state,
				mcpServerOfName: remainingServers
			};
		} else {
			// Add or update the server
			this.state = {
				...this.state,
				mcpServerOfName: {
					...this.state.mcpServerOfName,
					[serverName]: newServer
				}
			};
		}
		this._onDidChangeState.fire();
	};

	private readonly _setHasError = async (errMsg: string | undefined) => {
		this.state = {
			...this.state,
			error: errMsg,
		};
		this._onDidChangeState.fire();
	};

	// Create the file/directory if it doesn't exist
	private async _createMCPConfigFile(mcpConfigUri: URI): Promise<void> {
		await this.fileService.createFile(mcpConfigUri.with({ path: mcpConfigUri.path }));
		const buffer = VSBuffer.fromString(MCP_CONFIG_SAMPLE_STRING);
		await this.fileService.writeFile(mcpConfigUri, buffer);
	}


	private async _addMCPConfigFileWatcher(): Promise<void> {
		const mcpConfigUri = await this._getMCPConfigFilePath();
		this._register(
			this.fileService.watch(mcpConfigUri)
		);

		this._register(this.fileService.onDidFilesChange(e => {
			if (!e.contains(mcpConfigUri)) { return; }
			// Debounce bursts while editing mcp.json so tools refresh once without full window reload.
			this._scheduleMcpConfigRefresh.schedule();
		}));
	}

	// Client-side functions

	public async revealMCPConfigFile(): Promise<void> {
		try {
			const mcpConfigUri = await this._getMCPConfigFilePath();
			await this.editorService.openEditor({
				resource: mcpConfigUri,
				options: {
					pinned: true,
					revealIfOpened: true,
				}
			});
		} catch (error) {
			vibeLog.error('mcp', 'Error opening MCP config file:', error);
		}
	}

	public getMCPTools(): InternalToolInfo[] | undefined {
		const allTools: InternalToolInfo[] = [];
		for (const serverName in this.state.mcpServerOfName) {
			const server = this.state.mcpServerOfName[serverName];
			const sanitizedServer = sanitizeMcpIdentifier(serverName);
			server.tools?.forEach(tool => {
				const sanitizedTool = sanitizeMcpIdentifier(tool.name);
				// Model-facing identifier with collision-safe `<server>_<tool>` prefix.
				// Two MCP servers exposing same-named tools used to alias each other —
				// only the first by iteration won. `originalName` keeps the raw name
				// for the outbound MCP call.
				allTools.push({
					description: tool.description || '',
					params: this._transformInputSchemaToParams(tool.inputSchema),
					name: `${sanitizedServer}_${sanitizedTool}`,
					originalName: tool.name,
					mcpServerName: serverName,
				});
			});
		}
		if (allTools.length === 0) { return undefined; }
		return allTools;
	}

	/**
	 * VibeIDE: MCP tool deferral — returns tool definitions omitting descriptions
	 * when context is >10% full. Full descriptions loaded on demand via MCPSearch.
	 * Reduces ~85% of tokens from tool definitions in large contexts.
	 *
	 * @param contextPercentUsed - current context window usage (0-100)
	 */
	public getMCPToolsDeferred(contextPercentUsed: number): InternalToolInfo[] | undefined {
		const allTools = this.getMCPTools();
		if (!allTools) { return undefined; }

		// Defer tool descriptions when context is >10% full
		const DEFERRAL_THRESHOLD = 10;
		if (contextPercentUsed > DEFERRAL_THRESHOLD) {
			return allTools.map((tool): InternalToolInfo & { _deferred?: boolean } => ({
				...tool,
				description: `[deferred — use MCPSearch to load description for "${tool.name}"]`,
				params: {}, // omit params until requested
				_deferred: true,
			}));
		}

		return allTools;
	}

	private _transformInputSchemaToParams(inputSchema?: { properties?: Record<string, unknown> }): { [paramName: string]: { description: string } } {

		// Check if inputSchema is valid
		const properties = inputSchema?.properties;
		if (!properties) { return {}; }

		const params: { [paramName: string]: { description: string } } = {};
		Object.keys(properties).forEach(paramName => {
			const propertyValues = properties[paramName];

			// Check if propertyValues is not an object
			if (typeof propertyValues !== 'object') {
				vibeLog.warn('mcp', `Invalid property value for ${paramName}: expected object, got ${typeof propertyValues}`);
				return; // in forEach the return is equivalent to continue
			}

			// Add the parameter to the params object
			const description = (propertyValues as { description?: unknown }).description;
			params[paramName] = {
				description: JSON.stringify(description || '', null, 2) || '',
			};
		});
		return params;
	}

	private async _getMCPConfigFilePath(): Promise<URI> {
		const appName = this.productService.dataFolderName;
		const userHome = await this.pathService.userHome();
		const uri = URI.joinPath(userHome, appName, MCP_CONFIG_FILE_NAME);
		return uri;
	}

	private async _configFileExists(mcpConfigUri: URI): Promise<boolean> {
		try {
			await this.fileService.stat(mcpConfigUri);
			return true;
		} catch (error) {
			return false;
		}
	}


	private async _parseMCPConfigFile(): Promise<MCPConfigFileJSON | null> {
		const mcpConfigUri = await this._getMCPConfigFilePath();
		try {
			const fileContent = await this.fileService.readFile(mcpConfigUri);
			const contentString = fileContent.value.toString();
			const configFileJson = JSON.parse(contentString);
			if (!configFileJson.mcpServers) {
				throw new Error('Missing mcpServers property');
			}
			return configFileJson as MCPConfigFileJSON;
		} catch (error) {
			const fullError = `Error parsing MCP config file: ${error}`;
			this._setHasError(fullError);
			return null;
		}
	}


	/**
	 * Run the Config Guard over the MCP server entries: log every finding and notify once per distinct
	 * finding set. In `block` mode, returns the names of servers with a CRITICAL finding so the caller
	 * can keep them from starting. A clean scan resets the notification dedupe.
	 */
	private _runConfigGuard(servers: Record<string, MCPConfigFileEntryJSON>): Set<string> {
		const blockedNames = new Set<string>();
		if (this._configurationService.getValue<boolean>('vibeide.configGuard.enabled') === false) { this._lastGuardFindings = []; return blockedNames; }
		const findings = scanMcpConfig(servers);
		this._lastGuardFindings = findings;
		if (findings.length === 0) { this._lastGuardSig = ''; return blockedNames; }
		const block = this._configurationService.getValue<string>('vibeide.configGuard.mode') === 'block';
		for (const f of findings) {
			vibeLog.warn('mcp', `Config Guard [${f.severity}] ${f.message}`);
			if (block && f.severity === 'critical') { blockedNames.add(f.subject); }
		}
		this._notifyGuard(findings, block);
		return blockedNames;
	}

	/** One consolidated, deduped warning notification per distinct set of findings. */
	private _notifyGuard(findings: readonly ConfigGuardFinding[], block: boolean): void {
		const sig = findings.map(f => `${f.ruleId}:${f.subject}`).sort().join('|');
		if (sig === this._lastGuardSig) { return; }
		this._lastGuardSig = sig;
		const crit = findings.filter(f => f.severity === 'critical').length;
		const verb = block && crit > 0 ? 'заблокировал' : 'обнаружил';
		this._notificationService.warn(`Config Guard ${verb} проблемы безопасности в mcp.json: ${findings.length} (критичных: ${crit}). Подробности — в логе VibeIDE.`);
	}

	// Handle server state changes
	private async _refreshMCPServers(): Promise<void> {

		this._setHasError(undefined);

		const newConfigFileJSON = await this._parseMCPConfigFile();
		if (!newConfigFileJSON) { vibeLog.info('mcp', `Not setting state: MCP config file not found`); return; }
		if (!newConfigFileJSON?.mcpServers) { vibeLog.info('mcp', `Not setting state: MCP config file did not have an 'mcpServers' field`); return; }

		// Config Guard: static-scan server entries; in block mode, drop critical-flagged servers before
		// they start (filtering the parsed config so the rest of the refresh logic is untouched).
		const blockedNames = this._runConfigGuard(newConfigFileJSON.mcpServers);
		if (blockedNames.size > 0) {
			const filtered: Record<string, MCPConfigFileEntryJSON> = {};
			for (const [n, cfg] of Object.entries(newConfigFileJSON.mcpServers)) {
				if (!blockedNames.has(n)) { filtered[n] = cfg; }
			}
			newConfigFileJSON.mcpServers = filtered;
		}


		const oldConfigFileNames = Object.keys(this.state.mcpServerOfName);
		const newConfigFileNames = Object.keys(newConfigFileJSON.mcpServers);

		const addedServerNames = newConfigFileNames.filter(serverName => !oldConfigFileNames.includes(serverName)); // in new and not in old
		const removedServerNames = oldConfigFileNames.filter(serverName => !newConfigFileNames.includes(serverName)); // in old and not in new

		// set isOn to any new servers in the config
		const addedUserStateOfName: MCPUserStateOfName = {};
		for (const name of addedServerNames) { addedUserStateOfName[name] = { isOn: true }; }
		await this.vibeideSettingsService.addMCPUserStateOfNames(addedUserStateOfName);

		// delete isOn for any servers that no longer show up in the config
		await this.vibeideSettingsService.removeMCPUserStateOfNames(removedServerNames);

		// set all servers to loading
		for (const serverName in newConfigFileJSON.mcpServers) {
			this._setMCPServerState(serverName, { status: 'loading', tools: [] });
		}
		const updatedServerNames = Object.keys(newConfigFileJSON.mcpServers).filter(serverName => !addedServerNames.includes(serverName) && !removedServerNames.includes(serverName));

		this.channel.call('refreshMCPServers', {
			mcpConfigFileJSON: newConfigFileJSON,
			addedServerNames,
			removedServerNames,
			updatedServerNames,
			userStateOfName: this.vibeideSettingsService.state.mcpUserStateOfName,
		});
	}

	public getLastGuardFindings(): readonly ConfigGuardFinding[] {
		return this._lastGuardFindings;
	}

	stringifyResult(result: RawMCPToolCall): string {
		let toolResultStr: string;
		if (result.event === 'text') {
			toolResultStr = result.text;
		} else if (result.event === 'image') {
			toolResultStr = `[Image: ${result.image.mimeType}]`;
		} else if (result.event === 'audio') {
			toolResultStr = `[Audio content]`;
		} else if (result.event === 'resource') {
			toolResultStr = `[Resource content]`;
		} else {
			toolResultStr = JSON.stringify(result);
		}
		return toolResultStr;
	}

	// toggle MCP server and update isOn in void settings
	public async toggleServerIsOn(serverName: string, isOn: boolean): Promise<void> {
		this._setMCPServerState(serverName, { status: 'loading', tools: [] });

		await this.vibeideSettingsService.setMCPServerState(serverName, { isOn });
		this.channel.call('toggleMCPServer', { serverName, isOn });
	}


	public async callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }> {
		const t0 = Date.now();
		const result = await this.channel.call<RawMCPToolCall>('callTool', toolData);
		// Network panel collector (roadmap §1043) — record MCP tool call in ring buffer.
		this._outboundBuffer.record({
			timestampMs: t0,
			url: `mcp://${toolData.serverName}/${toolData.toolName}`,
			method: 'CALL',
			statusCode: result.event === 'error' ? 500 : 200,
			source: 'mcp',
			context: toolData.serverName,
		});
		if (result.event === 'error') {
			throw new Error(`Error: ${result.text}`);
		}
		return { result };
	}

	// public getMCPToolFns(): MCPToolResultType {
	// 	const tools = this.getMCPTools();
	// 	const toolFns: MCPToolResultType = {};

	// 	tools.forEach((tool) => {
	// 		const name = tool.name;
	// 		// Define the tool call function
	// 		const toolFn = async (params: {
	// 			serverName: string,
	// 			toolName: string,
	// 			args: any
	// 		}) => {
	// 			const { serverName, toolName, args } = params;
	// 			const response = await this.callMCPTool({
	// 				serverName,
	// 				toolName,
	// 				params: args,
	// 			});
	// 			return { result: response }
	// 		};
	// 		toolFns[name] = toolFn;
	// 	});

	// 	return toolFns
	// }
}

registerSingleton(IMCPService, MCPService, InstantiationType.Eager);
