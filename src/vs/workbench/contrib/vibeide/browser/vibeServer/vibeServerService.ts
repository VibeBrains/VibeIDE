/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Vibe Server orchestrator (renderer). Owns the active runtime, exposes lifecycle to the UI
 * (view pane, status bar, commands) and opens the preview either embedded (Simple Browser)
 * or in the external browser. The HTTP/reload server itself lives in main (see
 * electron-main/vibeServer/vibeServerMainService.ts).
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath, relativePath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { createDecorator, IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextKeyService, IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IChatThreadService } from '../chatThreadService.js';
import { IVibeServerMain, IVibeServerStarted, VIBE_SERVER_CHANNEL, VibeServerRuntimeKind } from '../../common/vibeServer/vibeServerIpc.js';
import { IVibeServerProcessMain, VIBE_SERVER_PROCESS_CHANNEL } from '../../common/vibeServer/vibeServerProcessIpc.js';
import { IVibeServerRuntime, StaticRuntime, DevServerRuntime } from './vibeServerRuntime.js';
import { DockerRuntime } from './vibeDockerRuntime.js';
import { VibeBrowserManager } from './vibeBrowserManager.js';
import { VibeServerConfigKeys, VibeServerPreviewTarget, VIBE_SERVER_RUNNING_CONTEXT_KEY } from './vibeServerConstants.js';

export const IVibeServerService = createDecorator<IVibeServerService>('vibeServerService');

export interface IVibeServerStatus {
	readonly state: 'stopped' | 'starting' | 'running';
	readonly started?: IVibeServerStarted;
	readonly kind?: VibeServerRuntimeKind;
}

export interface IVibeServerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeStatus: Event<void>;
	readonly status: IVibeServerStatus;
	/** Starts the preview server on the workspace root (runtime chosen by setting/auto-detect). */
	start(): Promise<void>;
	/** Brings up the project's Docker environment (compose/Dockerfile) and previews it. */
	startEnvironment(): Promise<void>;
	/** Stops then starts again, preserving the chosen runtime (Static/Dev/Docker). */
	restart(): Promise<void>;
	/** Stops the running server. No-op when stopped. */
	stop(): Promise<void>;
	/** Number of console errors/warnings captured from the embedded preview (for status/badge). */
	problemCount(): number;
	/** Opens the preview at the server root; `target` overrides the configured default. */
	openPreview(target?: VibeServerPreviewTarget): Promise<void>;
	/** Opens an additional embedded preview tab (multi-preview). */
	openPreviewNewTab(): Promise<void>;
	/** Force-reloads all open embedded preview tabs. */
	reloadPreview(): void;
	/** Starts the server if needed, then opens the preview at the given workspace file. */
	openPreviewForResource(resource: URI): Promise<void>;
	/** Copies the running server URL to the clipboard. */
	copyUrl(): Promise<void>;
	/** AI-loop: adds the preview's captured console errors as context for the next chat turn. */
	sendPreviewErrorsToChat(): Promise<void>;
	/** Copies the LAN URL (for previewing on a phone) to the clipboard. */
	showLanAddress(): Promise<void>;
	/** Returns the LAN URL (`http://<ip>:<port>/`) or undefined when unavailable. */
	getLanUrl(): Promise<string | undefined>;
}

class VibeServerService extends Disposable implements IVibeServerService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeStatus = this._register(new Emitter<void>());
	readonly onDidChangeStatus = this._onDidChangeStatus.event;

	private readonly _main: IVibeServerMain;
	private readonly _procMain: IVibeServerProcessMain;
	private readonly _runtime = this._register(new MutableDisposable<IVibeServerRuntime>());
	/** External-URI mappings (tunnels on remote); held until the server stops. */
	private readonly _externalUris = this._register(new DisposableStore());
	/** Embedded browser; created on first embedded preview and reused across restarts. */
	private readonly _browser = this._register(new MutableDisposable<VibeBrowserManager>());
	private readonly _runningKey: IContextKey<boolean>;
	private _status: IVibeServerStatus = { state: 'stopped' };
	/** Runtime kind forced by the last start (e.g. Docker via startEnvironment) — preserved on restart. */
	private _lastForcedKind: VibeServerRuntimeKind | undefined;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IEditorService private readonly _editorService: IEditorService,
		@IFileService private readonly _fileService: IFileService,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._main = ProxyChannel.toService<IVibeServerMain>(mainProcessService.getChannel(VIBE_SERVER_CHANNEL));
		this._procMain = ProxyChannel.toService<IVibeServerProcessMain>(mainProcessService.getChannel(VIBE_SERVER_PROCESS_CHANNEL));
		this._runningKey = contextKeyService.createKey<boolean>(VIBE_SERVER_RUNNING_CONTEXT_KEY, false);
		this._register(this._editorService.onDidActiveEditorChange(() => void this._maybeAutoNavigate()));
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VibeServerConfigKeys.scrollSync)) {
				this._browser.value?.setScrollSync(this._configurationService.getValue<boolean>(VibeServerConfigKeys.scrollSync) === true);
			}
		}));
	}

	get status(): IVibeServerStatus {
		return this._status;
	}

	start(): Promise<void> {
		return this._startWithKind(undefined);
	}

	startEnvironment(): Promise<void> {
		return this._startWithKind(VibeServerRuntimeKind.docker);
	}

	async restart(): Promise<void> {
		const forced = this._lastForcedKind;
		await this.stop();
		await this._startWithKind(forced);
	}

	private async _startWithKind(forced: VibeServerRuntimeKind | undefined): Promise<void> {
		if (this._status.state !== 'stopped') {
			return;
		}
		this._lastForcedKind = forced;
		const root = this._resolveRoot();
		if (!root) {
			this._notificationService.info(localize('vibeServer.needFolder', "Откройте папку, чтобы запустить Vibe Server."));
			return;
		}

		this._setStatus({ state: 'starting' });
		const kind = forced ?? await this._detectRuntimeKind(root);
		const runtime = this._createRuntime(kind, root);
		runtime.onDidLog(line => this._logService.info(`[VibeServer] ${line}`));

		let started: IVibeServerStarted;
		try {
			started = await runtime.start();
		} catch (err) {
			runtime.dispose();
			this._setStatus({ state: 'stopped' });
			this._notificationService.error(localize('vibeServer.startFailed', "Не удалось запустить Vibe Server: {0}", String(err)));
			return;
		}

		this._runtime.value = runtime;
		this._setStatus({ state: 'running', started, kind: runtime.kind });

		if (this._configurationService.getValue<boolean>(VibeServerConfigKeys.openAutomatically) !== false) {
			await this.openPreview();
		}
	}

	async stop(): Promise<void> {
		if (this._status.state === 'stopped') {
			return;
		}
		this._externalUris.clear();
		const runtime = this._runtime.value;
		await runtime?.stop();
		this._runtime.clear(); // disposes the runtime
		this._setStatus({ state: 'stopped' });
		// The embedded browser is intentionally kept open: a later start reuses the same tab.
	}

	async openPreview(target?: VibeServerPreviewTarget): Promise<void> {
		const started = this._status.started;
		if (this._status.state !== 'running' || !started) {
			this._notificationService.info(localize('vibeServer.notRunning', "Vibe Server не запущен."));
			return;
		}
		await this._openUrl(started.url, target);
	}

	async openPreviewNewTab(): Promise<void> {
		const started = this._status.started;
		if (this._status.state !== 'running' || !started) {
			this._notificationService.info(localize('vibeServer.notRunning', "Vibe Server не запущен."));
			return;
		}
		await this._openUrl(started.url, 'embedded', true);
	}

	async openPreviewForResource(resource: URI): Promise<void> {
		if (this._status.state === 'stopped') {
			await this.start();
		}
		const url = this._resourceToLoopbackUrl(resource);
		if (!url) {
			return;
		}
		await this._openUrl(url, undefined);
	}

	/** Resolves the URL (tunnelled on remote) and opens it embedded or externally. */
	private async _openUrl(rawUrl: string, target: VibeServerPreviewTarget | undefined, newTab = false): Promise<void> {
		const mode: VibeServerPreviewTarget = target
			?? (this._configurationService.getValue<VibeServerPreviewTarget>(VibeServerConfigKeys.previewTarget) ?? 'embedded');

		const externalUrl = await this._resolveExternal(rawUrl);
		if (mode === 'external') {
			await this._openerService.open(externalUrl, { openExternal: true });
			return;
		}
		this._ensureBrowser().open(externalUrl.toString(true), newTab);
	}

	/** asExternalUri equivalent: tunnelled on remote, identity on desktop. */
	private async _resolveExternal(rawUrl: string): Promise<URI> {
		const uri = URI.parse(rawUrl);
		try {
			const resolved = await this._openerService.resolveExternalUri(uri, { allowTunneling: true });
			this._externalUris.add(resolved);
			return resolved.resolved;
		} catch {
			// Plain desktop: no external-URI resolver / tunnel provider — loopback is reachable
			// directly, so fall back to the raw URI instead of failing the preview.
			return uri;
		}
	}

	problemCount(): number {
		return this._browser.value?.problemCount() ?? 0;
	}

	reloadPreview(): void {
		this._browser.value?.reloadAll();
	}

	private _ensureBrowser(): VibeBrowserManager {
		if (!this._browser.value) {
			const manager = this._instantiationService.createInstance(VibeBrowserManager);
			manager.setScrollSync(this._configurationService.getValue<boolean>(VibeServerConfigKeys.scrollSync) === true);
			// Surface new preview problems on the status bar via the status-change event.
			manager.onDidChangeProblems(() => this._onDidChangeStatus.fire());
			this._browser.value = manager;
		}
		return this._browser.value;
	}

	/** Maps a workspace file under the server root to its loopback URL, or undefined if outside. */
	private _resourceToLoopbackUrl(resource: URI): string | undefined {
		const started = this._status.started;
		if (!started) {
			return undefined;
		}
		const root = this._resolveRoot();
		const relative = root ? relativePath(root, resource) : undefined;
		if (relative === undefined || relative.startsWith('..')) {
			return started.url;
		}
		return started.url + relative.split('/').map(encodeURIComponent).join('/');
	}

	/** When enabled and the embedded browser is open, follow the active HTML editor. */
	private async _maybeAutoNavigate(): Promise<void> {
		if (this._status.state !== 'running' || !this._browser.value) {
			return;
		}
		if (this._configurationService.getValue<boolean>(VibeServerConfigKeys.autoNavigate) !== true) {
			return;
		}
		const resource = this._editorService.activeEditor?.resource;
		if (!resource || !/\.html?$/i.test(resource.path)) {
			return;
		}
		const root = this._resolveRoot();
		const relative = root ? relativePath(root, resource) : undefined;
		if (relative === undefined || relative.startsWith('..')) {
			return;
		}
		const externalUrl = await this._resolveExternal(this._resourceToLoopbackUrl(resource)!);
		this._browser.value.navigate(externalUrl.toString(true));
	}

	async copyUrl(): Promise<void> {
		const url = this._status.started?.url;
		if (url) {
			await this._clipboardService.writeText(url);
		}
	}

	async sendPreviewErrorsToChat(): Promise<void> {
		const browser = this._browser.value;
		const problems = browser?.recentProblems() ?? [];
		if (!browser || problems.length === 0) {
			this._notificationService.info(localize('vibeServer.noProblems', "В превью нет зафиксированных ошибок консоли."));
			return;
		}
		const threadId = this._chatThreadService.state.currentThreadId;
		if (!threadId) {
			this._notificationService.info(localize('vibeServer.noThread', "Нет активного чата для добавления контекста."));
			return;
		}
		const body = problems.map(p => `[${p.level}] ${p.text}`).join('\n');
		const where = browser.currentUrl ?? this._status.started?.url ?? '';
		const text = localize('vibeServer.errorsContext', "Ошибки из консоли превью Vibe Server ({0}):\n{1}", where, body);
		this._chatThreadService.addPendingInjection(threadId, text);
		this._notificationService.info(localize('vibeServer.errorsAdded', "Ошибки превью ({0}) добавлены в чат — отправьте сообщение, и они подмешаются к ходу.", problems.length));
	}

	async getLanUrl(): Promise<string | undefined> {
		const started = this._status.started;
		if (this._status.state !== 'running' || !started) {
			return undefined;
		}
		const ip = await this._main.lanAddress();
		return ip ? `${started.url.startsWith('https') ? 'https' : 'http'}://${ip}:${started.port}/` : undefined;
	}

	async showLanAddress(): Promise<void> {
		const started = this._status.started;
		if (this._status.state !== 'running' || !started) {
			this._notificationService.info(localize('vibeServer.lanNotRunning', "Vibe Server не запущен."));
			return;
		}
		const lanUrl = await this.getLanUrl();
		if (!lanUrl) {
			this._notificationService.info(localize('vibeServer.noLan', "Не удалось определить адрес в локальной сети."));
			return;
		}
		await this._clipboardService.writeText(lanUrl);
		const loopbackBound = started.host === '127.0.0.1' || started.host === 'localhost';
		if (loopbackBound) {
			this._notificationService.warn(localize('vibeServer.lanHint', "Адрес скопирован: {0}. Для доступа из сети задайте vibeide.vibeServer.host = 0.0.0.0 и перезапустите сервер.", lanUrl));
		} else {
			this._notificationService.info(localize('vibeServer.lanCopied', "Адрес для телефона скопирован: {0}", lanUrl));
		}
	}

	private _resolveRoot(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		const base = folders[0].uri;
		const relative = this._configurationService.getValue<string>(VibeServerConfigKeys.root);
		return relative && relative.trim().length > 0 ? joinPath(base, relative.trim()) : base;
	}

	private _createRuntime(kind: VibeServerRuntimeKind, root: URI): IVibeServerRuntime {
		switch (kind) {
			case VibeServerRuntimeKind.docker:
				return this._instantiationService.createInstance(DockerRuntime, root, this._procMain);
			case VibeServerRuntimeKind.devServer:
				return this._instantiationService.createInstance(DevServerRuntime, root, this._procMain);
			default:
				return this._instantiationService.createInstance(StaticRuntime, root, this._main);
		}
	}

	/** Picks the runtime: explicit setting, or auto — dev-server when a dev/start/serve script exists. */
	private async _detectRuntimeKind(root: URI): Promise<VibeServerRuntimeKind> {
		const setting = this._configurationService.getValue<string>(VibeServerConfigKeys.runtime) ?? 'auto';
		if (setting === 'static') {
			return VibeServerRuntimeKind.static;
		}
		if (setting === 'devServer') {
			return VibeServerRuntimeKind.devServer;
		}
		if (setting === 'docker') {
			return VibeServerRuntimeKind.docker;
		}
		try {
			const content = (await this._fileService.readFile(joinPath(root, 'package.json'))).value.toString();
			const scripts = (JSON.parse(content)?.scripts ?? {}) as Record<string, unknown>;
			if (['dev', 'start', 'serve'].some(s => typeof scripts[s] === 'string')) {
				return VibeServerRuntimeKind.devServer;
			}
		} catch { /* no/invalid package.json → static */ }
		return VibeServerRuntimeKind.static;
	}

	private _setStatus(status: IVibeServerStatus): void {
		this._status = status;
		this._runningKey.set(status.state === 'running');
		this._onDidChangeStatus.fire();
	}
}

registerSingleton(IVibeServerService, VibeServerService, InstantiationType.Delayed);
