/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { language } from '../../../../base/common/platform.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { McpApps } from '../../../../platform/mcp/common/modelContextProtocolApps.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { isDark } from '../../../../platform/theme/common/theme.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { injectMcpAppPreamble } from '../../chat/browser/widget/chatContentParts/toolInvocationParts/chatMcpAppModel.js';
import { readResourceContentToHtml } from '../../mcp/browser/mcpToolCallUI.js';
import { MCP } from '../../mcp/common/modelContextProtocol.js';
import { IWebviewElement, IWebviewService, WebviewContentPurpose, WebviewOriginStore } from '../../webview/browser/webview.js';
import { IChatThreadService } from './chatThreadService.js';
import { IMCPService } from '../common/mcpService.js';
import { isMcpAppLinkAllowed, mcpAppMessageText } from '../common/mcpApps.js';
import { vibeLog } from '../common/vibeLog.js';

/** Height of an app before it reports its own. */
export const MCP_APP_DEFAULT_HEIGHT = 300;
/** Cap on the height an app may ask for, so one app cannot push the conversation out of the view. */
const MCP_APP_MAX_HEIGHT = 800;
/** Apps of one server share a webview origin across restarts, as upstream does. */
const ORIGIN_STORE_KEY = 'vibeide.mcpApp.origins';
/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601;
/** JSON-RPC server error for a handler that failed. */
const HANDLER_FAILED = -32000;

/** What the chat knows about the tool call an app renders. */
export interface IVibeMcpAppData {
	readonly serverName: string;
	/** Raw tool name on the server. */
	readonly toolName: string;
	readonly resourceUri: string;
	readonly input: Record<string, unknown> | undefined;
	readonly callResult: MCP.CallToolResult | undefined;
	readonly threadId: string;
}

type IncomingMessage = { method: string; id?: string | number; params?: unknown };

/**
 * Host of one MCP App in the VibeIDE chat.
 *
 * Upstream's `ChatMcpAppModel` is welded to the upstream chat (tool invocations, chat widgets, the
 * response file system), so this host speaks the same protocol against our services. What it grants
 * is deliberately narrow: inline display only, no sampling, no downloads, no model-context updates.
 * Everything that reaches outside the frame — calling a tool, opening a link — asks the person first.
 */
export class VibeMcpAppHost extends Disposable {

	private readonly _webview: IWebviewElement;
	private _initialized = false;
	private _csp: McpApps.McpUiResourceCsp | undefined;
	/** Asked once per app: after a yes, the app's buttons work without a dialog on every click. */
	private _toolCallsAllowed: boolean | undefined;

	private readonly _onDidChangeHeight = this._register(new Emitter<number>());
	readonly onDidChangeHeight: Event<number> = this._onDidChangeHeight.event;
	private readonly _onDidFail = this._register(new Emitter<string>());
	readonly onDidFail: Event<string> = this._onDidFail.event;

	constructor(
		private readonly _container: HTMLElement,
		private readonly _data: IVibeMcpAppData,
		@IWebviewService webviewService: IWebviewService,
		@IStorageService storageService: IStorageService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IDialogService private readonly _dialogService: IDialogService,
		@IThemeService private readonly _themeService: IThemeService,
		@IProductService private readonly _productService: IProductService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super();
		const origin = new WebviewOriginStore(ORIGIN_STORE_KEY, storageService).getOrigin('mcpApp', _data.serverName);
		this._webview = this._register(webviewService.createWebviewElement({
			origin,
			title: localize('vibeide.mcpApp.title', "Приложение MCP"),
			options: {
				purpose: WebviewContentPurpose.ChatOutputItem,
				enableFindWidget: false,
				disableServiceWorker: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowMultipleAPIAcquire: true,
				allowScripts: true,
				allowForms: true,
			},
			extension: undefined,
		}));
		this._webview.mountTo(_container, dom.getWindow(_container));

		this._register(this._webview.onMessage(({ message }) => { void this._handleMessage(message as IncomingMessage); }));
		this._register(this._themeService.onDidColorThemeChange(() => {
			if (this._initialized) {
				void this._post({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: this._hostContext() });
			}
		}));

		void this._load();
	}

	private async _load(): Promise<void> {
		try {
			const read = await this._mcpService.readAppResource(this._data.serverName, this._data.resourceUri);
			const content = readResourceContentToHtml(read.contents);
			if (!content.mimeType.startsWith('text/html')) {
				throw new Error(`UI resource is ${content.mimeType}, not HTML`);
			}
			this._csp = content.csp;
			this._webview.setHtml(injectMcpAppPreamble(content));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			vibeLog.warn('mcpApp', `MCP App ${this._data.resourceUri} of ${this._data.serverName} failed to load: ${message}`);
			this._onDidFail.fire(message);
		}
	}

	private _hostContext(): McpApps.McpUiHostContext {
		return {
			theme: isDark(this._themeService.getColorTheme().type) ? 'dark' : 'light',
			displayMode: 'inline',
			availableDisplayModes: ['inline'],
			containerDimensions: { width: this._container.clientWidth, maxHeight: MCP_APP_MAX_HEIGHT },
			locale: language,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			platform: 'desktop',
		};
	}

	private async _handleMessage(message: IncomingMessage): Promise<void> {
		try {
			const result = await this._dispatch(message);
			if (message.id !== undefined) {
				if (result === METHOD_NOT_FOUND) {
					await this._post({ jsonrpc: '2.0', id: message.id, error: { code: METHOD_NOT_FOUND, message: `Method not supported: ${message.method}` } });
				} else {
					await this._post({ jsonrpc: '2.0', id: message.id, result });
				}
			}
			if (message.method === 'ui/initialize') {
				// The spec wants the tool input, then the result, after initialize has been answered.
				this._initialized = true;
				await this._post({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: this._data.input ?? {} } });
				if (this._data.callResult) {
					await this._post({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: this._data.callResult });
				}
			}
		} catch (err) {
			const text = err instanceof Error ? err.message : String(err);
			vibeLog.warn('mcpApp', `MCP App ${this._data.serverName}: ${message.method} failed: ${text}`);
			if (message.id !== undefined) {
				await this._post({ jsonrpc: '2.0', id: message.id, error: { code: HANDLER_FAILED, message: text } });
			}
		}
	}

	/** The answer to a request, `undefined` for a notification, or METHOD_NOT_FOUND. */
	private async _dispatch(message: IncomingMessage): Promise<unknown> {
		switch (message.method) {
			case 'ui/initialize':
				return {
					protocolVersion: McpApps.LATEST_PROTOCOL_VERSION,
					hostInfo: { name: this._productService.nameLong, version: this._productService.version },
					hostCapabilities: {
						openLinks: {},
						serverTools: {},
						serverResources: {},
						logging: {},
						sandbox: { csp: this._csp },
						message: { text: {} },
					},
					hostContext: this._hostContext(),
				} satisfies McpApps.McpUiInitializeResult;
			case 'ping':
				return {};
			case 'tools/call':
				return this._callTool(message.params as MCP.CallToolRequestParams);
			case 'resources/read': {
				const uri = (message.params as MCP.ReadResourceRequestParams | undefined)?.uri;
				if (!uri) { throw new Error('Missing uri in resources/read'); }
				return this._mcpService.readAppResource(this._data.serverName, uri);
			}
			case 'ui/open-link':
				return this._openLink((message.params as McpApps.McpUiOpenLinkRequest['params']).url);
			case 'ui/message':
				return this._message(message.params as McpApps.McpUiMessageRequest['params']);
			case 'ui/request-display-mode':
				return { mode: 'inline' } satisfies McpApps.McpUiRequestDisplayModeResult;
			case 'ui/notifications/size-changed': {
				const height = (message.params as McpApps.McpUiSizeChangedNotification['params']).height;
				if (typeof height === 'number' && height > 0) {
					this._onDidChangeHeight.fire(Math.min(Math.ceil(height), MCP_APP_MAX_HEIGHT));
				}
				return undefined;
			}
			case 'notifications/message':
				vibeLog.info('mcpApp', `MCP App ${this._data.serverName}:`, message.params);
				return undefined;
			case 'ui/notifications/initialized':
			case 'ui/notifications/sandbox-wheel':
				return undefined;
			default:
				// Sampling, downloads and model-context updates are not offered in initialize.
				return METHOD_NOT_FOUND;
		}
	}

	private async _callTool(params: MCP.CallToolRequestParams | undefined): Promise<MCP.CallToolResult> {
		if (!params?.name) {
			throw new Error('Missing tool name in tools/call');
		}
		if (this._toolCallsAllowed === undefined) {
			const { confirmed } = await this._dialogService.confirm({
				message: localize('vibeide.mcpApp.allowTools', "Разрешить приложению сервера «{0}» вызывать его инструменты?", this._data.serverName),
				detail: localize('vibeide.mcpApp.allowToolsDetail', "Приложение просит вызвать «{0}». Разрешение действует, пока приложение открыто в чате.", params.name),
				primaryButton: localize('vibeide.mcpApp.allow', "Разрешить"),
			});
			this._toolCallsAllowed = confirmed;
		}
		if (!this._toolCallsAllowed) {
			throw new Error('The user declined tool calls from this app');
		}
		return this._mcpService.callToolFromApp(this._data.serverName, params.name, params.arguments ?? {});
	}

	private async _openLink(url: string): Promise<McpApps.McpUiOpenLinkResult> {
		if (!isMcpAppLinkAllowed(url)) {
			return { isError: true };
		}
		const { confirmed } = await this._dialogService.confirm({
			message: localize('vibeide.mcpApp.openLink', "Приложение сервера «{0}» хочет открыть ссылку", this._data.serverName),
			detail: url,
			primaryButton: localize('vibeide.mcpApp.open', "Открыть"),
		});
		if (!confirmed) {
			return { isError: true };
		}
		const opened = await this._openerService.open(URI.parse(url, true), { openExternal: true });
		return { isError: !opened };
	}

	private _message(params: McpApps.McpUiMessageRequest['params']): McpApps.McpUiMessageResult {
		const placed = this._chatThreadService.offerThreadDraft(this._data.threadId, mcpAppMessageText(params.content));
		return { isError: !placed };
	}

	private async _post(message: object): Promise<void> {
		await this._webview.postMessage(message);
	}
}
