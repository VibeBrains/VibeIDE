/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IMCPService` (contract lives in `../common/mcpService.ts`).
 *
 * Talks to the main process over `vibe-channel-mcp` via `IMainProcessService` — banned in
 * `common/**` and `browser/**`, hence the split. Uses the raw `IChannel` rather than
 * `ProxyChannel`: it needs `channel.listen` for the push streams (`onAdd_server`,
 * `onUpdate_server`, …) that main emits while MCP servers come and go.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — a browser-layer module cannot import
 * electron-browser.
 */

import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { coerceFieldValue, ElicitationAnswer, ElicitationForm, McpInputAsk, rootsAnswer } from '../common/mcpElicitation.js';
import { AcpMcpExportResult, buildAcpMcpServers } from '../common/acp/acpMcpExport.js';
import { localize } from '../../../../nls.js';
import { builtinTools, InternalToolInfo } from '../common/prompt/prompts.js';
import { vibeLog } from '../common/vibeLog.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { MCPConfigFileJSON, MCPConfigFileEntryJSON, MCPServer, MCPToolCallParams, RawMCPToolCall, MCPServerEventResponse, MCPAppRequestOutcome, MCPReadResourceParams, MCPTool, MCPSyncParams } from '../common/mcpServiceTypes.js';
import { MCP } from '../../mcp/common/modelContextProtocol.js';
import { mcpAppsEnabledConfig } from '../../../../platform/mcp/common/mcpManagement.js';
import { isMcpToolCallableByApp, isMcpToolVisibleToModel, mcpAppUiOfTool } from '../common/mcpApps.js';
import { isMcpToolAllowedByEntry } from '../common/mcpToolAllowlist.js';
import { IAuditLogService } from '../common/auditLogService.js';
import { Event, Emitter } from '../../../../base/common/event.js';
import { RunOnceScheduler, raceTimeout } from '../../../../base/common/async.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { MCPUserStateOfName } from '../common/vibeideSettingsTypes.js';
import { IVibeOutboundRingBuffer } from '../common/vibeOutboundRingBuffer.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { McpToolDefinitions, McpToolDrift, McpToolPinsStore, describeDefinitions, diffToolDefinitions, serverPinKey, toolDefinitionsOf, withheldToolsOf } from '../common/mcpToolPins.js';
import { MCP_REQUIRE_TOOL_REAPPROVAL_KEY } from '../common/mcpToolPinsConfiguration.js';
import { scanMcpConfig, ConfigGuardFinding } from '../common/vibeConfigGuard.js';
import { IMCPService, MCPServiceState } from '../common/mcpService.js';
import { FoundHeadersHelper, FoundMemoryServer, FoundTeamServer, teamServerOfSidecar, VIBE_MEMORY_DIR_ENV, VIBE_MEMORY_SERVER_NAME, VIBE_MEMORY_TEAM_SERVER_PREFIX, VIBE_MEMORY_TEAM_SIDECAR, VIBE_MEMORY_TOKENS_FOLDER, vibeMemoryEngine, VibeMemoryEngine, vibeMemoryHelperPathSegments, vibeMemoryServerPathSegments, withDiscoveredMemoryServer, withDiscoveredTeamServers } from '../common/vibeMemoryServerDiscovery.js';
import { IShellEnvironmentService } from '../../../services/environment/electron-browser/shellEnvironmentService.js';
import { MEMORY_PROJECT_RESOLVE_TOOL, MemoryProjectAnswer, parseProjectResolveAnswer, TeamMemoryProject } from '../common/vibeMemoryProject.js';
import { joinPath } from '../../../../base/common/resources.js';
import { isWindows } from '../../../../base/common/platform.js';

const MCP_CONFIG_FILE_NAME = 'mcp.json';
/** How long prompt assembly waits for the memory server to name a folder's project. */
const MEMORY_PROJECT_RESOLVE_TIMEOUT_MS = 3000;
const MCP_CONFIG_SAMPLE = { mcpServers: {} };
const MCP_CONFIG_SAMPLE_STRING = JSON.stringify(MCP_CONFIG_SAMPLE, null, 2);

/**
 * Reduce an arbitrary string to the character set that downstream tool-calling
 * adapters accept for tool names: `[a-zA-Z0-9_-]`. Spaces, slashes, dots and
 * unicode are folded to underscores. Matches Kilo's `sanitize` in
 * packages/opencode/src/mcp/index.ts.
 */
const sanitizeMcpIdentifier = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/**
 * The longest tool name providers accept. A server whose `<server>_<tool>` runs past it is refused whole, not cut:
 * two cut names can meet, and a request carrying one long name is refused by the provider for every tool at once
 */
const MODEL_TOOL_NAME_MAX = 64;


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
		toolDriftOfName: {},
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
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IShellEnvironmentService private readonly _shellEnvironmentService: IShellEnvironmentService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		this._toolPins = new McpToolPinsStore(storageService);
		this.channel = this.mainProcessService.getChannel('vibe-channel-mcp');


		const onEvent = (e: MCPServerEventResponse) => {
			// console.log('GOT EVENT', e)
			this._setMCPServerState(e.response.name, e.response.newServer);
		};
		this._register((this.channel.listen('onAdd_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onUpdate_server') satisfies Event<MCPServerEventResponse>)(onEvent));
		this._register((this.channel.listen('onDelete_server') satisfies Event<MCPServerEventResponse>)(onEvent));

		// MRTR: сервер просит ввод — вопрос показывается ЧЕЛОВЕКУ здесь, в окне, и ответ уходит
		// обратно в главный процесс, который повторяет вызов. Модель в этом не участвует.
		this._register((this.channel.listen('onInputRequest') satisfies Event<McpInputAsk>)(ask => void this._answerInputRequest(ask)));

		// Turning MCP Apps on or off changes what every client announces, so all servers reconnect.
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(mcpAppsEnabledConfig)) { this._scheduleMcpConfigRefresh.schedule(); }
		}));

		this._initialize();
	}


	/**
	 * Спросить человека по просьбе сервера и ответить главному процессу.
	 *
	 * Отказ — законный исход: закрытый вопрос возвращается словом `decline`, как того требует
	 * протокол, а не пустым ответом, который сервер принял бы за согласие.
	 */
	private async _answerInputRequest(ask: McpInputAsk): Promise<void> {
		const responses: Record<string, unknown> = {};
		try {
			// `roots/list` отвечается без человека: папки окна известны, а лишний диалог превратил
			// бы обычный вызов инструмента в допрос.
			for (const key of ask.rootKeys) {
				responses[key] = rootsAnswer(this._workspace.getWorkspace().folders.map(folder => ({ uri: folder.uri.toString(), name: folder.name })));
			}
			for (const { key, form } of ask.elicitations) {
				const answer = await this._askHuman(ask, form);
				if (answer.action !== 'accept') {
					// Отказ прекращает весь вызов: отвечать на часть просьб и молчать об остальных
					// значит отдать серверу состояние, по которому он не сможет продолжить.
					this.channel.call('answerInputRequest', { requestId: ask.requestId, answer: { ok: false, reason: answer.action === 'decline' ? 'пользователь отказался отвечать' : 'пользователь закрыл вопрос' } });
					return;
				}
				responses[key] = answer;
			}
			this.channel.call('answerInputRequest', { requestId: ask.requestId, answer: { ok: true, responses } });
		} catch (error) {
			vibeLog.error('mcp', 'не удалось спросить пользователя по просьбе MCP-сервера', error);
			this.channel.call('answerInputRequest', { requestId: ask.requestId, answer: { ok: false, reason: 'окно не смогло показать вопрос' } });
		}
	}

	/** Форма по полям схемы: строка, число, булево и перечисление — большего спека не допускает. */
	private async _askHuman(ask: McpInputAsk, form: ElicitationForm): Promise<ElicitationAnswer> {
		const title = `${ask.serverName} → ${ask.toolName}`;
		if (form.fields.length === 0) {
			// Просьба без полей — это вопрос «да или нет» по самому сообщению.
			const confirmed = await this._quickInput.pick(
				[{ label: localize('vibeide.mcp.elicit.yes', 'Разрешить') }, { label: localize('vibeide.mcp.elicit.no', 'Отказать') }],
				{ title, placeHolder: form.message });
			return confirmed?.label === localize('vibeide.mcp.elicit.yes', 'Разрешить') ? { action: 'accept', content: {} } : { action: 'decline' };
		}
		const content: Record<string, unknown> = {};
		for (const field of form.fields) {
			const prompt = field.description ? `${field.label} — ${field.description}` : field.label;
			let raw: string | undefined;
			if (field.type === 'boolean') {
				const picked = await this._quickInput.pick([{ label: 'true' }, { label: 'false' }], { title, placeHolder: prompt });
				raw = picked?.label;
			} else if (field.type === 'enum' && field.options?.length) {
				const picked = await this._quickInput.pick(field.options.map(option => ({ label: option })), { title, placeHolder: prompt });
				raw = picked?.label;
			} else {
				raw = await this._quickInput.input({ title, prompt: form.message, placeHolder: prompt });
			}
			if (raw === undefined) { return { action: 'cancel' }; }
			// Необязательное поле, оставленное пустым, не уезжает вовсе: пустая строка — это ответ
			// «пусто», а отсутствие поля — «не отвечал», и сервер читает их по-разному.
			if (raw === '' && !field.required) { continue; }
			content[field.key] = coerceFieldValue(field, raw);
		}
		return { action: 'accept', content };
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
		if (serverName === VIBE_MEMORY_SERVER_NAME) {
			// A reconnected server may have a different store or new rules: ask again.
			this._memoryProjectOfFolder.clear();
		}
		this._warnAboutShadowedBuiltins(serverName, newServer);
		this._checkToolPins(serverName, newServer);
		this._publishToolDrift();
		this._onDidChangeState.fire();
	};

	// ── Tool definitions changed after approval ───────────────────────────────────

	private readonly _toolPins: McpToolPinsStore;
	/** Tools of each server hidden from the model until a person has looked at their change. */
	private readonly _withheldTools = new Map<string, ReadonlySet<string>>();
	/** The change awaiting a look, per server: what to pin once it is accepted. */
	private readonly _pendingDrift = new Map<string, { readonly key: string; readonly pinned: McpToolDefinitions; readonly current: McpToolDefinitions; readonly drift: McpToolDrift }>();
	/** The last change announced per server: a list re-read on a timer must not announce it again. */
	private readonly _announcedDrift = new Map<string, string>();
	/** Read-only documents for the before/after comparison; registered on first use. */
	private _driftDocuments: InMemoryFileSystemProvider | undefined;
	/** The open announcement per server, closed once its change is settled some other way. */
	private readonly _driftNotices = new Map<string, INotificationHandle>();

	/**
	 * Compare the server's tools with what was approved. The first listing is pinned silently; a later
	 * change or addition is withheld and announced; a removal alone just updates the pin. With the check
	 * switched off every listing is accepted — and still pinned, so switching it back on starts from now.
	 */
	private _checkToolPins(serverName: string, server: MCPServer | undefined): void {
		if (!server || server.status !== 'success' || !server.tools) {
			// A server out of work offers nothing. The announcement is kept, so a server that comes back
			// with the same change is not announced a second time.
			this._withheldTools.delete(serverName);
			this._pendingDrift.delete(serverName);
			return;
		}
		const key = serverPinKey(serverName, this._serverEntries[serverName]);
		const current = toolDefinitionsOf(server.tools);
		const pinned = this._toolPins.get(key);
		if (!pinned) {
			// First listing: adding the server to mcp.json was the consent.
			this._toolPins.set(key, current);
			this._forgetToolDrift(serverName);
			return;
		}
		const drift = diffToolDefinitions(pinned, current);
		const needsLook = drift.changed.length > 0 || drift.added.length > 0;
		if (!needsLook || this._configurationService.getValue<boolean>(MCP_REQUIRE_TOOL_REAPPROVAL_KEY) === false) {
			if (needsLook || drift.removed.length > 0) {
				this._toolPins.set(key, current);
			}
			this._forgetToolDrift(serverName);
			return;
		}
		this._withheldTools.set(serverName, withheldToolsOf(drift));
		this._pendingDrift.set(serverName, { key, pinned, current, drift });
		const signature = JSON.stringify(drift) + JSON.stringify(drift.changed.map(name => current[name]));
		if (this._announcedDrift.get(serverName) === signature) {
			return;
		}
		this._announcedDrift.set(serverName, signature);
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({ ts: Date.now(), actor: 'system', action: 'mcp_tool_drift', ok: false, meta: { serverName, changed: drift.changed, added: drift.added, removed: drift.removed } }).catch(() => { });
		}
		this._driftNotices.get(serverName)?.close();
		this._driftNotices.set(serverName, this._notificationService.prompt(
			Severity.Warning,
			localize('vibeide.mcp.drift.notify', "MCP-сервер «{0}» изменил инструменты после одобрения: изменено {1}, добавлено {2}. Пока вы их не посмотрите, агент их не видит. Решить можно и позже: настройки VibeIDE, раздел MCP.", serverName, drift.changed.length, drift.added.length),
			[
				// Looking comes before deciding: the announcement stays open, so «Принять» is still there after the diff.
				{ label: localize('vibeide.mcp.drift.show', "Показать изменения"), keepOpen: true, run: () => void this.showToolDrift(serverName) },
				{ label: localize('vibeide.mcp.drift.accept', "Принять"), run: () => this.acceptToolDrift(serverName) },
			],
			{ sticky: true },
		));
	}

	private _forgetToolDrift(serverName: string): void {
		this._withheldTools.delete(serverName);
		this._pendingDrift.delete(serverName);
		this._announcedDrift.delete(serverName);
		this._driftNotices.get(serverName)?.close();
		this._driftNotices.delete(serverName);
	}

	/** The waiting changes as the UI sees them, in a new state object — the same object would not re-render. */
	private _publishToolDrift(): void {
		const toolDriftOfName: Record<string, McpToolDrift> = {};
		for (const [serverName, pending] of this._pendingDrift) {
			toolDriftOfName[serverName] = pending.drift;
		}
		this.state = { ...this.state, toolDriftOfName };
	}

	/** Before and after, side by side, for the changed and added tools only. */
	async showToolDrift(serverName: string): Promise<void> {
		const pending = this._pendingDrift.get(serverName);
		if (!pending) {
			return;
		}
		if (!this._driftDocuments) {
			this._driftDocuments = this._register(new InMemoryFileSystemProvider());
			this._register(this.fileService.registerProvider(MCP_DRIFT_SCHEME, this._driftDocuments));
		}
		const names = [...pending.drift.changed, ...pending.drift.added];
		const folder = URI.from({ scheme: MCP_DRIFT_SCHEME, path: `/${encodeURIComponent(serverName)}` });
		const before = joinPath(folder, 'approved.json');
		const after = joinPath(folder, 'now.json');
		this._driftDocuments.setReadOnly(false);
		await this.fileService.writeFile(before, VSBuffer.fromString(describeDefinitions(pending.pinned, names)));
		await this.fileService.writeFile(after, VSBuffer.fromString(describeDefinitions(pending.current, names)));
		this._driftDocuments.setReadOnly(true);
		await this.editorService.openEditor({
			original: { resource: before },
			modified: { resource: after },
			label: localize('vibeide.mcp.drift.diffTitle', "MCP «{0}»: одобрено ↔ сейчас", serverName),
		});
	}

	acceptToolDrift(serverName: string): void {
		const pending = this._pendingDrift.get(serverName);
		if (!pending) {
			return;
		}
		this._toolPins.set(pending.key, pending.current);
		this._forgetToolDrift(serverName);
		this._publishToolDrift();
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({ ts: Date.now(), actor: 'human', action: 'mcp_tool_drift_approved', ok: true, meta: { serverName, changed: pending.drift.changed, added: pending.drift.added, removed: pending.drift.removed } }).catch(() => { });
		}
		this._onDidChangeState.fire();
	}

	private readonly _longNameWarned = new Set<string>();

	/** Once per server per session: the list is rebuilt on every request, and a repeated notification goes unread */
	private _warnToolNameTooLong(serverName: string, toolName: string): void {
		if (this._longNameWarned.has(serverName)) { return; }
		this._longNameWarned.add(serverName);
		this._notificationService.warn(localize('vibeide.mcp.toolNameTooLong', "Инструменты MCP-сервера «{0}» не предложены модели: имя «{0}_{1}» длиннее {2} символов, а провайдеры такие отклоняют. Сократите имя сервера в mcp.json.", serverName, toolName, MODEL_TOOL_NAME_MAX));
	}

	/**
	 * Projects of each team's memory, by server; kept until the server list is rebuilt
	 * The host cannot see this disk, so it answers with the projects the token may use, not with a folder's project
	 */
	private readonly _teamProjectsOfServer = new Map<string, MemoryProjectAnswer>();

	public async resolveTeamMemoryProjects(folder: string): Promise<readonly TeamMemoryProject[]> {
		const out: TeamMemoryProject[] = [];
		for (const [serverName, server] of Object.entries(this.state.mcpServerOfName)) {
			if (!serverName.startsWith(VIBE_MEMORY_TEAM_SERVER_PREFIX) || server?.status !== 'success' || !server.tools.some(t => t.name === MEMORY_PROJECT_RESOLVE_TOOL)) {
				continue;
			}
			let answer = this._teamProjectsOfServer.get(serverName);
			if (!answer) {
				const params: MCPToolCallParams = { serverName, toolName: MEMORY_PROJECT_RESOLVE_TOOL, params: { directory: folder } };
				const result = await raceTimeout(this.channel.call<RawMCPToolCall | undefined>('callTool', params), MEMORY_PROJECT_RESOLVE_TIMEOUT_MS);
				answer = result?.event === 'text' ? parseProjectResolveAnswer(result.text) : undefined;
				if (answer) { this._teamProjectsOfServer.set(serverName, answer); }
			}
			if (answer) {
				out.push({ serverName, toolPrefix: `${sanitizeMcpIdentifier(serverName)}_`, answer });
			}
		}
		return out;
	}

	/** Answers of `project_resolve` by folder; only real answers are kept, so a slow server is asked again. */
	private readonly _memoryProjectOfFolder = new Map<string, MemoryProjectAnswer>();

	public async resolveMemoryProject(folder: string): Promise<MemoryProjectAnswer | undefined> {
		const cached = this._memoryProjectOfFolder.get(folder);
		if (cached) { return cached; }
		const server = this.state.mcpServerOfName[VIBE_MEMORY_SERVER_NAME];
		if (server?.status !== 'success' || !server.tools.some(t => t.name === MEMORY_PROJECT_RESOLVE_TOOL)) {
			return undefined;
		}
		const params: MCPToolCallParams = { serverName: VIBE_MEMORY_SERVER_NAME, toolName: MEMORY_PROJECT_RESOLVE_TOOL, params: { directory: folder } };
		const result = await raceTimeout(this.channel.call<RawMCPToolCall | undefined>('callTool', params), MEMORY_PROJECT_RESOLVE_TIMEOUT_MS);
		if (result?.event !== 'text') {
			vibeLog.info('mcp', `VibeMemory: project_resolve for ${folder} gave no answer`);
			return undefined;
		}
		const answer = parseProjectResolveAnswer(result.text);
		if (answer) { this._memoryProjectOfFolder.set(folder, answer); }
		return answer;
	}

	/**
	 * Сказать вслух, если инструмент сервера получил имя встроенного.
	 *
	 * MCP tools are already namespaced as `<server>_<tool>`, so this is rare rather than routine — it
	 * takes a server called `read` offering a tool called `file`. Rare is not the same as harmless:
	 * the tool is renamed to keep the request valid, and a rename nobody is told about is exactly the
	 * silent shadowing the renaming exists to prevent.
	 *
	 * Reported once per server per session: the state fires on every refresh, and a notification that
	 * repeats is one the user learns to dismiss unread.
	 */
	private readonly _shadowWarned = new Set<string>();

	private _warnAboutShadowedBuiltins(serverName: string, server: MCPServer | undefined): void {
		if (!server?.tools?.length || this._shadowWarned.has(serverName)) {
			return;
		}
		const sanitizedServer = sanitizeMcpIdentifier(serverName);
		const shadowed = server.tools
			.map(tool => `${sanitizedServer}_${sanitizeMcpIdentifier(tool.name)}`)
			.filter(name => MCPService._builtinNames.has(name));
		if (shadowed.length === 0) {
			return;
		}
		this._shadowWarned.add(serverName);
		this._notificationService.warn(localize(
			'vibeide.mcp.shadowedBuiltin',
			'Сервер «{0}» объявил инструменты с именами встроенных: {1}. Они переименованы (к имени добавлен «_mcp»), иначе запрос с двумя одинаковыми именами отклоняют строгие провайдеры. Вызывать их можно по новому имени.',
			serverName, shadowed.join(', '),
		));
	}

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
		void this._watchTeamTokens();
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

	/** Names the model already knows from the built-in toolset. */
	private static readonly _builtinNames = new Set(Object.keys(builtinTools));

	public getMCPTools(): InternalToolInfo[] | undefined {
		const allTools: InternalToolInfo[] = [];
		for (const serverName in this.state.mcpServerOfName) {
			const server = this.state.mcpServerOfName[serverName];
			const sanitizedServer = sanitizeMcpIdentifier(serverName);
			const tooLong = server.tools?.find(tool => `${sanitizedServer}_${sanitizeMcpIdentifier(tool.name)}`.length > MODEL_TOOL_NAME_MAX);
			if (tooLong) {
				this._warnToolNameTooLong(serverName, tooLong.name);
				continue;
			}
			server.tools?.forEach(tool => {
				// An app-only tool exists for the app's buttons; offering it to the model would break the spec's promise.
				if (!isMcpToolVisibleToModel(tool)) { return; }
				// A tool outside the entry's own list is not offered: the model cannot ask for what it never saw.
				if (!isMcpToolAllowedByEntry(this._serverEntries[serverName], tool.name)) { return; }
				// Nor is one that changed after approval: its new description is an instruction nobody reviewed.
				if (this._withheldTools.get(serverName)?.has(tool.name)) { return; }
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
	/**
	 * The VibeMemory server binary, if installed. Absent is not an error — most people do not run
	 * VibeMemory — so it is one log line, not a notification.
	 */
	private async _findMemoryServer(): Promise<FoundMemoryServer | undefined> {
		try {
			const home = await this.pathService.userHome();
			const engine = await this._vibeMemoryEngine();
			const binary = joinPath(engine.dir, ...vibeMemoryServerPathSegments(isWindows));
			if (!await this.fileService.exists(binary)) {
				vibeLog.info('mcp', 'VibeMemory: сервер памяти не установлен — общая память агенту недоступна');
				return undefined;
			}
			return { command: binary.fsPath, homeDir: home.fsPath, ...(engine.env ? { env: engine.env } : {}) };
		} catch (err) {
			vibeLog.warn('mcp', 'VibeMemory: не удалось проверить сервер памяти', err);
			return undefined;
		}
	}

	/**
	 * VibeMemory's engine folder: `VIBEMEMORY_DIR` of the user's shell, else `~/.vibememory`
	 * The shell's environment and not the IDE's own: an IDE started from the Dock does not have the shell's variables
	 */
	private async _vibeMemoryEngine(): Promise<VibeMemoryEngine> {
		const home = await this.pathService.userHome();
		const shellEnv = await this._shellEnvironmentService.getShellEnv();
		return vibeMemoryEngine(home, shellEnv[VIBE_MEMORY_DIR_ENV]);
	}

	/**
	 * Teams this machine was connected to: their sidecars in `tokens/*` of the engine folder, and the helper that prints
	 * a team's header. The token files are never opened here. A skipped sidecar is one log line with the reason
	 */
	private async _findTeamServers(): Promise<{ readonly teams: readonly FoundTeamServer[]; readonly helper: FoundHeadersHelper | undefined }> {
		try {
			const engine = await this._vibeMemoryEngine();
			const tokens = joinPath(engine.dir, VIBE_MEMORY_TOKENS_FOLDER);
			if (!await this.fileService.exists(tokens)) {
				return { teams: [], helper: undefined };
			}
			const helper = joinPath(engine.dir, ...vibeMemoryHelperPathSegments(isWindows));
			if (!await this.fileService.exists(helper)) {
				vibeLog.warn('mcp', 'VibeMemory: есть подключённые команды, но нет помощника vibememory — память команды недоступна');
				return { teams: [], helper: undefined };
			}
			const folder = await this.fileService.resolve(tokens);
			const teams: FoundTeamServer[] = [];
			for (const child of folder.children ?? []) {
				const sidecar = joinPath(child.resource, VIBE_MEMORY_TEAM_SIDECAR);
				if (!child.isDirectory || !await this.fileService.exists(sidecar)) {
					continue;
				}
				const found = teamServerOfSidecar(child.name, (await this.fileService.readFile(sidecar)).value.toString());
				if ('skipped' in found) {
					vibeLog.warn('mcp', `VibeMemory: команда пропущена — ${found.skipped}`);
				} else {
					teams.push(found);
				}
			}
			return { teams, helper: { command: helper.fsPath, ...(engine.env ? { env: engine.env } : {}) } };
		} catch (err) {
			vibeLog.warn('mcp', 'VibeMemory: не удалось прочитать подключённые команды', err);
			return { teams: [], helper: undefined };
		}
	}

	/**
	 * `connect` and `disconnect` take effect without a restart: the tokens folder is watched, or, before the first
	 * team, the VibeMemory folder until the tokens folder appears
	 */
	private readonly _teamTokensWatcher = this._register(new MutableDisposable<DisposableStore>());

	private async _watchTeamTokens(): Promise<void> {
		const engine = await this._vibeMemoryEngine();
		const tokens = joinPath(engine.dir, VIBE_MEMORY_TOKENS_FOLDER);
		const hasTokens = await this.fileService.exists(tokens);
		const target = hasTokens ? tokens : engine.dir;
		if (!hasTokens && !await this.fileService.exists(target)) {
			this._teamTokensWatcher.clear();
			return;
		}
		const store = new DisposableStore();
		if (hasTokens) {
			// A sidecar lies two levels down, and only a plain watch goes deep; the folder is small
			store.add(this.fileService.watch(tokens, { recursive: true, excludes: [] }));
			store.add(this.fileService.onDidFilesChange(e => {
				if (e.affects(tokens)) { this._scheduleMcpConfigRefresh.schedule(); }
			}));
		} else {
			const watcher = store.add(this.fileService.createWatcher(target, { recursive: false, excludes: [] }));
			store.add(watcher.onDidChange(e => {
				if (!e.affects(tokens)) { return; }
				void this._watchTeamTokens();
				this._scheduleMcpConfigRefresh.schedule();
			}));
		}
		this._teamTokensWatcher.value = store;
	}

	private async _refreshMCPServers(): Promise<void> {

		this._setHasError(undefined);

		const newConfigFileJSON = await this._parseMCPConfigFile();
		if (!newConfigFileJSON) { vibeLog.info('mcp', `Not setting state: MCP config file not found`); return; }
		if (!newConfigFileJSON?.mcpServers) { vibeLog.info('mcp', `Not setting state: MCP config file did not have an 'mcpServers' field`); return; }
		this._serverEntries = { ...newConfigFileJSON.mcpServers };

		// The family's shared memory joins by itself when VibeMemory is installed; a user entry with the
		// same name wins. Added before Config Guard, so the discovered entry is scanned like any other.
		newConfigFileJSON.mcpServers = withDiscoveredMemoryServer(newConfigFileJSON.mcpServers, await this._findMemoryServer());
		// Team memory over HTTPS: one server per team this machine was connected to, the header from VibeMemory's helper.
		// Discovered entries stay out of `_serverEntries`, so a guest agent never gets them (acpMcpExport.ts)
		const teams = await this._findTeamServers();
		newConfigFileJSON.mcpServers = withDiscoveredTeamServers(newConfigFileJSON.mcpServers, teams.teams, teams.helper);
		this._teamProjectsOfServer.clear();

		// On/off is kept for every configured server, a blocked one included: unblocked, it comes back as it was.
		const configuredNames = Object.keys(newConfigFileJSON.mcpServers);

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


		// New and gone are judged against the SAVED on/off, not this window's list: a reloaded window starts with
		// an empty list, and judging by it switched back on every server the user had switched off.
		const savedStateOfName = this.vibeideSettingsService.state.mcpUserStateOfName;
		const newStateOfName: MCPUserStateOfName = {};
		for (const name of configuredNames) {
			if (!Object.hasOwn(savedStateOfName, name)) { newStateOfName[name] = { isOn: true }; }
		}
		await this.vibeideSettingsService.addMCPUserStateOfNames(newStateOfName);
		await this.vibeideSettingsService.removeMCPUserStateOfNames(Object.keys(savedStateOfName).filter(name => !configuredNames.includes(name)));

		// This window's list follows the config at once; what runs is the main process's to say.
		const wantedNames = Object.keys(newConfigFileJSON.mcpServers);
		for (const name of Object.keys(this.state.mcpServerOfName)) {
			if (!wantedNames.includes(name)) { this._setMCPServerState(name, undefined); }
		}
		for (const name of wantedNames) {
			if (!this.state.mcpServerOfName[name]) { this._setMCPServerState(name, { status: 'loading', tools: [] }); }
		}

		// The whole picture, not a diff: the main process compares it with the clients that actually run,
		// which every window shares (common/mcpReconcile.ts).
		const enabledOfName: Record<string, boolean> = {};
		for (const name of wantedNames) {
			enabledOfName[name] = this.vibeideSettingsService.state.mcpUserStateOfName[name]?.isOn !== false;
		}
		const params: MCPSyncParams = { entries: newConfigFileJSON.mcpServers, enabledOfName, appsEnabled: this._appsEnabled() };
		this.channel.call('syncMCPServers', params);
	}

	private _appsEnabled(): boolean {
		return this._configurationService.getValue<boolean>(mcpAppsEnabledConfig) !== false;
	}

	/** A tool of a server by its model-facing `<server>_<tool>` name or by its raw name. */
	private _findTool(serverName: string, name: string): MCPTool | undefined {
		const sanitizedServer = sanitizeMcpIdentifier(serverName);
		return this.state.mcpServerOfName[serverName]?.tools?.find(t => t.name === name || `${sanitizedServer}_${sanitizeMcpIdentifier(t.name)}` === name);
	}

	public getAppResourceUri(serverName: string, modelToolName: string): string | undefined {
		if (!this._appsEnabled()) { return undefined; }
		const tool = this._findTool(serverName, modelToolName);
		return tool ? mcpAppUiOfTool(tool).resourceUri : undefined;
	}

	public async readAppResource(serverName: string, uri: string): Promise<MCP.ReadResourceResult> {
		const params: MCPReadResourceParams = { serverName, uri };
		return this._unwrapAppOutcome(await this.channel.call<MCPAppRequestOutcome<MCP.ReadResourceResult> | undefined>('readResource', params));
	}

	public async callToolFromApp(serverName: string, toolName: string, args: Record<string, unknown>): Promise<MCP.CallToolResult> {
		const tool = this.state.mcpServerOfName[serverName]?.tools?.find(t => t.name === toolName);
		if (!tool) {
			throw new Error(`Tool ${toolName} not found on server ${serverName}`);
		}
		if (!isMcpToolCallableByApp(tool)) {
			throw new Error(`Tool ${toolName} is not callable by an app`);
		}
		this._refuseUnlistedTool(serverName, toolName);
		const params: MCPToolCallParams = { serverName, toolName, params: args };
		const t0 = Date.now();
		const outcome = await this.channel.call<MCPAppRequestOutcome<MCP.CallToolResult> | undefined>('callToolForApp', params);
		this._outboundBuffer.record({
			timestampMs: t0,
			url: `mcp://${serverName}/${toolName}`,
			method: 'CALL',
			statusCode: outcome?.ok ? 200 : 500,
			source: 'mcp',
			context: serverName,
		});
		return this._unwrapAppOutcome(outcome);
	}

	private _unwrapAppOutcome<T>(outcome: MCPAppRequestOutcome<T> | undefined): T {
		if (!outcome) {
			throw new Error('MCP channel returned no answer');
		}
		if (!outcome.ok) {
			throw new Error(outcome.error);
		}
		return outcome.value;
	}

	/** Entries of the last read `mcp.json`, for the per-server tool list. */
	private _serverEntries: Record<string, MCPConfigFileEntryJSON> = {};

	/**
	 * Refuse a call before it reaches the server, and say so in the audit log: a tool outside the entry's
	 * tool list, or one that changed after approval and has not been looked at yet.
	 */
	private _refuseUnlistedTool(serverName: string, toolName: string): void {
		const notListed = !isMcpToolAllowedByEntry(this._serverEntries[serverName], toolName);
		const changed = !notListed && !!this._withheldTools.get(serverName)?.has(toolName);
		if (!notListed && !changed) {
			return;
		}
		if (this._auditLogService.isEnabled()) {
			void this._auditLogService.append({ ts: Date.now(), actor: 'agent', action: 'mcp_tool_refused', ok: false, meta: { serverName, toolName, reason: notListed ? 'notListed' : 'changedAfterApproval' } }).catch(() => { });
		}
		throw new Error(notListed
			? localize('vibeide.mcp.toolNotListed', 'Инструмент «{0}» сервера «{1}» не входит в список tools его записи в mcp.json — вызов отклонён до обращения к серверу.', toolName, serverName)
			: localize('vibeide.mcp.toolChanged', 'Инструмент «{0}» сервера «{1}» изменился после одобрения — вызов отклонён, пока вы не посмотрите изменения.', toolName, serverName));
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

	public getAcpMcpServers(names: readonly string[]): AcpMcpExportResult {
		// Выключатель читается оттуда же, откуда его пишет `toggleServerIsOn`: выключенный у нас сервер
		// не должен оказаться включённым у гостя. Новый сервер без записи состояния считается включённым — так же,
		// как при загрузке конфига.
		const userState = this.vibeideSettingsService.state.mcpUserStateOfName;
		return buildAcpMcpServers({
			entries: this._serverEntries,
			allowed: names,
			isEnabled: name => userState[name]?.isOn !== false,
		});
	}

	// toggle MCP server and update isOn in void settings
	public async toggleServerIsOn(serverName: string, isOn: boolean): Promise<void> {
		this._setMCPServerState(serverName, { status: 'loading', tools: [] });

		await this.vibeideSettingsService.setMCPServerState(serverName, { isOn });
		this.channel.call('toggleMCPServer', { serverName, isOn });
	}


	public async callMCPTool(toolData: MCPToolCallParams): Promise<{ result: RawMCPToolCall }> {
		this._refuseUnlistedTool(toolData.serverName, toolData.toolName);
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

/** Scheme of the read-only before/after documents of a tool change. */
const MCP_DRIFT_SCHEME = 'vibe-mcp-drift';

registerSingleton(IMCPService, MCPService, InstantiationType.Eager);
