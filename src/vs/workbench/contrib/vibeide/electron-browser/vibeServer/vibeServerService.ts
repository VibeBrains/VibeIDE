/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IVibeServerService` (contract lives in
 * `../../browser/vibeServer/vibeServerService.ts`).
 *
 * Reaches the main process over two channels — `VIBE_SERVER_CHANNEL` (the preview server itself) and
 * `VIBE_SERVER_PROCESS_CHANNEL` (port ownership) — through `IMainProcessService`, which is banned in
 * `common/**` and `browser/**`. The runtimes it drives (Static / DevServer / Docker) and the browser
 * manager stay in `browser/vibeServer/`: they are environment-agnostic and are imported from here.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — a browser-layer module cannot import
 * electron-browser.
 */

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath, relativePath } from '../../../../../base/common/resources.js';
import { escapeRegExpCharacters } from '../../../../../base/common/strings.js';
import { localize } from '../../../../../nls.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IContextKeyService, IContextKey } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IChatThreadService } from '../../browser/chatThreadService.js';
import { IVibeServerMain, IVibeServerStarted, VIBE_SERVER_CHANNEL, VibeServerRuntimeKind } from '../../common/vibeServer/vibeServerIpc.js';
import { IVibeServerPortOwner, IVibeServerProcessMain, VIBE_SERVER_PROCESS_CHANNEL } from '../../common/vibeServer/vibeServerProcessIpc.js';
import { IVibeServerRuntime, StaticRuntime, DevServerRuntime, DevServerPortBusyError } from '../../browser/vibeServer/vibeServerRuntime.js';
import { DockerRuntime } from '../../browser/vibeServer/vibeDockerRuntime.js';
import { VibeBrowserManager, IVibeBrowserElementPick, DesignScanResult } from '../../browser/vibeServer/vibeBrowserManager.js';
import { openVibeChatEditor } from '../../browser/vibeideChatPane.js';
import { VibeServerConfigKeys, VibeServerPreviewTarget, VIBE_SERVER_RUNNING_CONTEXT_KEY } from '../../browser/vibeServer/vibeServerConstants.js';
import { IVibeServerService, IVibeServerStatus } from '../../browser/vibeServer/vibeServerService.js';

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
	/** Subscription to the active runtime's unexpected-exit signal; cleared on stop. */
	private readonly _runtimeExitListener = this._register(new MutableDisposable());
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
		@IDialogService private readonly _dialogService: IDialogService,
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
			if (err instanceof DevServerPortBusyError && this._portConflictPromptEnabled()) {
				await this._promptBusyPortNoFallback(err.busyPort, forced);
				return;
			}
			this._notificationService.error(localize('vibeServer.startFailed', "Не удалось запустить Vibe Server: {0}", String(err)));
			return;
		}

		this._runtime.value = runtime;
		if (runtime.onDidExitUnexpectedly) {
			this._runtimeExitListener.value = runtime.onDidExitUnexpectedly(() => {
				this._notificationService.warn(localize('vibeServer.devServerDied', "Dev-server неожиданно завершился — Vibe Server остановлен."));
				void this.stop();
			});
		}
		this._setStatus({ state: 'running', started, kind: runtime.kind });

		if (started.requestedPort !== undefined && this._portConflictPromptEnabled()) {
			const keepFallback = await this._promptPortFallback(started, forced);
			if (!keepFallback) {
				return; // freed+restarted (preview opens in the nested start) or stopped
			}
		}

		if (this._configurationService.getValue<boolean>(VibeServerConfigKeys.openAutomatically) !== false) {
			await this.openPreview();
		}
	}

	async stop(): Promise<void> {
		if (this._status.state === 'stopped') {
			return;
		}
		this._externalUris.clear();
		this._runtimeExitListener.clear();
		const runtime = this._runtime.value;
		await runtime?.stop();
		this._runtime.clear(); // disposes the runtime
		this._setStatus({ state: 'stopped' });
		// The embedded browser is intentionally kept open: a later start reuses the same tab.
	}

	private _portConflictPromptEnabled(): boolean {
		return this._configurationService.getValue<boolean>(VibeServerConfigKeys.portConflictPrompt) !== false;
	}

	/**
	 * The dev-server fell back to another port because the project's port is busy. Asks the user
	 * to free the project port (kill the owner + restart), keep working on the fallback port for
	 * this session, or cancel (stop — the user untangles it themselves). Returns `true` when the
	 * fallback port stays in use and the caller should proceed to open the preview.
	 */
	private async _promptPortFallback(started: IVibeServerStarted, forced: VibeServerRuntimeKind | undefined): Promise<boolean> {
		const requested = started.requestedPort!;
		const owners = await this._describePortOwnersSafe(requested);
		const vibeCwd = owners.find(o => o.vibeCwd)?.vibeCwd;
		const freeButton = {
			label: localize('vibeServer.conflict.free', "Освободить порт {0}", requested),
			run: () => 'free' as const,
		};
		const keepButton = {
			label: localize('vibeServer.conflict.keep', "Работать на {0}", started.port),
			run: () => 'keep' as const,
		};
		const { result } = await this._dialogService.prompt<'free' | 'keep'>({
			type: 'warning',
			message: localize('vibeServer.conflict.message', "Порт {0} занят — dev-сервер запущен на порту {1}", requested, started.port),
			detail: this._portConflictDetail(requested, started.port, owners, vibeCwd),
			// When the port is held by another VibeIDE-managed project, default to coexisting on
			// the fallback port instead of killing a sibling dev-server.
			buttons: vibeCwd ? [keepButton, freeButton] : [freeButton, keepButton],
			cancelButton: true,
		});
		if (result === 'keep') {
			return true;
		}
		if (result === 'free') {
			await this._procMain.killPort(requested);
			await this.stop();
			await this._startWithKind(forced);
			return false;
		}
		// Cancelled: the user resolves the conflict themselves — leave nothing running.
		await this.stop();
		return false;
	}

	/** The dev-server crashed on a busy port (no framework fallback): offer to free it and retry. */
	private async _promptBusyPortNoFallback(busyPort: number, forced: VibeServerRuntimeKind | undefined): Promise<void> {
		const owners = await this._describePortOwnersSafe(busyPort);
		const vibeCwd = owners.find(o => o.vibeCwd)?.vibeCwd;
		const { confirmed } = await this._dialogService.confirm({
			type: 'warning',
			message: localize('vibeServer.busyPort.message', "Порт {0} занят — dev-сервер не смог запуститься", busyPort),
			detail: this._portConflictDetail(busyPort, undefined, owners, vibeCwd),
			primaryButton: localize('vibeServer.busyPort.free', "Освободить порт {0}", busyPort),
		});
		if (!confirmed) {
			return;
		}
		await this._procMain.killPort(busyPort);
		await this._startWithKind(forced);
	}

	private async _describePortOwnersSafe(port: number): Promise<IVibeServerPortOwner[]> {
		try {
			return await this._procMain.describePortOwners(port);
		} catch (err) {
			this._logService.warn('[VibeServer] could not describe port owners', err);
			return [];
		}
	}

	private _portConflictDetail(requested: number, fallbackPort: number | undefined, owners: IVibeServerPortOwner[], vibeCwd: string | undefined): string {
		const who = vibeCwd
			? localize('vibeServer.conflict.ownVibe', "Порт держит dev-сервер проекта «{0}», запущенный в VibeIDE.", vibeCwd)
			: owners.length > 0
				? localize('vibeServer.conflict.foreign', "Порт держит процесс PID {0}: {1}", owners[0].pid, owners[0].commandLine.length > 120 ? `${owners[0].commandLine.slice(0, 120)}…` : owners[0].commandLine || localize('vibeServer.conflict.unknownCmd', "команда неизвестна"))
				: localize('vibeServer.conflict.unknown', "Процесс, занимающий порт, определить не удалось.");
		const note = fallbackPort !== undefined
			? localize('vibeServer.conflict.note', "Порт в конфигурации проекта не меняется: «Работать на {0}» использует новый порт только в этой сессии.", fallbackPort)
			: localize('vibeServer.busyPort.note', "«Освободить порт {0}» завершит этот процесс и запустит dev-сервер заново.", requested);
		return `${who}\n\n${note}`;
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

	async scanDesign(): Promise<DesignScanResult> {
		// Deliberately does NOT open a preview: scanning is a read of what the user is looking at,
		// and spawning a window as a side effect of a measurement would be a surprise.
		const browser = this._browser.value;
		if (!browser) {
			return { ok: false, reason: 'no-preview' };
		}
		return browser.scanDesign();
	}

	private _ensureBrowser(): VibeBrowserManager {
		if (!this._browser.value) {
			// Cookie compat (VS.6): while a preview tab shows a loopback URL, main rewrites its
			// Set-Cookie to `SameSite=None; Secure` so dev-site logins survive the cross-site
			// iframe. The config gate lives HERE (register is simply skipped when disabled) —
			// zero config plumbing in the main process. Unregister is unconditional: the
			// refcounted registry ignores unknown origins, and this way a mid-session config
			// flip can never leak a stale registration.
			const manager = this._instantiationService.createInstance(VibeBrowserManager, {
				register: (url: string) => {
					if (this._configurationService.getValue<boolean>(VibeServerConfigKeys.cookieCompat) !== false) {
						void this._main.registerPreviewOrigin(url);
					}
				},
				unregister: (url: string) => {
					void this._main.unregisterPreviewOrigin(url);
				},
			});
			manager.setScrollSync(this._configurationService.getValue<boolean>(VibeServerConfigKeys.scrollSync) === true);
			// Surface new preview problems on the status bar via the status-change event.
			manager.onDidChangeProblems(() => this._onDidChangeStatus.fire());
			// Element inspect: picks arrive from the preview chrome; availability follows the
			// runtime kind (the bridge script is injected by the static server only).
			manager.onDidPickElement(pick => void this._handleInspectPick(pick));
			manager.setInspectSupported(this._status.state === 'running' && this._status.kind === VibeServerRuntimeKind.static);
			this._browser.value = manager;
		}
		return this._browser.value;
	}

	/**
	 * An element was picked in the preview inspect mode: resolve the file candidate
	 * (static runtime — deterministic pathname→file mirror of `_resourceToLoopbackUrl`),
	 * find the selector's line in it, and stage a Russian edit blueprint in the chat as a
	 * pending injection (the `sendPreviewErrorsToChat` pattern: visible chip, not sent).
	 */
	private async _handleInspectPick(pick: IVibeBrowserElementPick): Promise<void> {
		const threadId = this._chatThreadService.state.currentThreadId;
		if (!threadId) {
			this._notificationService.info(localize('vibeServer.noThread', "Нет активного чата для добавления контекста."));
			return;
		}
		const candidate = await this._inspectFileCandidate(pick.path);
		const line = candidate ? await this._findSelectorLine(candidate.uri, pick.selector) : undefined;

		const fileNote = candidate
			? candidate.spaGuess
				? localize('vibeServer.inspect.fileSpa', "Файл-кандидат (SPA fallback, предположительно): {0}", candidate.relative + (line !== undefined ? `:${line}` : ''))
				: localize('vibeServer.inspect.file', "Файл: {0}", candidate.relative + (line !== undefined ? `:${line}` : ''))
			: localize('vibeServer.inspect.noFile', "Файл в workspace не определён — найди элемент по селектору.");
		const text = [
			localize('vibeServer.inspect.header', "Правка по элементу из превью Vibe Server."),
			localize('vibeServer.inspect.page', "Страница: {0}", pick.path || pick.href),
			localize('vibeServer.inspect.selector', "Селектор: {0}", pick.selector),
			fileNote,
			localize('vibeServer.inspect.fragment', "Фрагмент HTML:"),
			'```html',
			pick.html,
			'```',
		].join('\n');
		this._chatThreadService.addPendingInjection(threadId, text);

		await openVibeChatEditor(this._instantiationService);
		await this._chatThreadService.focusCurrentChat();
		this._notificationService.info(localize('vibeServer.inspect.staged', "Элемент {0} добавлен в чат заметкой — опишите правку и отправьте сообщение.", pick.selector));
	}

	/**
	 * Deterministic pathname→file mapping for the static runtime (mirror of the main-side
	 * `_handle`): decode, resolve under the served root, directory → `index.html`. When the
	 * path resolves to nothing and SPA fallback is on, the root `index.html` is returned as
	 * a guess. Returns undefined outside the static runtime — there is no mapping there.
	 */
	private async _inspectFileCandidate(pathname: string): Promise<{ uri: URI; relative: string; spaGuess: boolean } | undefined> {
		if (this._status.state !== 'running' || this._status.kind !== VibeServerRuntimeKind.static) {
			return undefined;
		}
		const root = this._resolveRoot();
		if (!root || !pathname.startsWith('/')) {
			return undefined;
		}
		let relative: string;
		try {
			relative = decodeURIComponent(pathname).replace(/^\/+/, '');
		} catch {
			return undefined;
		}
		if (relative.split('/').some(segment => segment === '..')) {
			return undefined;
		}
		if (relative === '' || relative.endsWith('/')) {
			relative += 'index.html';
		}
		if (await this._fileService.exists(joinPath(root, relative))) {
			return { uri: joinPath(root, relative), relative, spaGuess: false };
		}
		// `/docs` without a trailing slash may still be the `docs/index.html` directory form.
		const lastSegment = relative.split('/').pop() ?? '';
		if (!lastSegment.includes('.') && await this._fileService.exists(joinPath(root, `${relative}/index.html`))) {
			return { uri: joinPath(root, `${relative}/index.html`), relative: `${relative}/index.html`, spaGuess: false };
		}
		if (this._configurationService.getValue<boolean>(VibeServerConfigKeys.spaFallback) === true && await this._fileService.exists(joinPath(root, 'index.html'))) {
			return { uri: joinPath(root, 'index.html'), relative: 'index.html', spaGuess: true };
		}
		return undefined;
	}

	/**
	 * Best-effort 1-based line of the picked element in the source HTML: anchors on the last
	 * selector segment (id → `id="…"`, class → `class` attribute containing it, else `<tag`).
	 * A candidate, not truth — JS-mutated DOM may not match the source markup.
	 */
	private async _findSelectorLine(resource: URI, selector: string): Promise<number | undefined> {
		let content: string;
		try {
			const file = await this._fileService.readFile(resource, { limits: { size: 1024 * 1024 } });
			content = file.value.toString();
		} catch {
			return undefined;
		}
		const lastSegment = selector.split('>').pop()?.trim() ?? '';
		let needle: RegExp | undefined;
		const idMatch = /^#(?<id>[\w\\-]+)/.exec(lastSegment);
		const classMatch = /\.(?<cls>[\w\\-]+)/.exec(lastSegment);
		const tagMatch = /^(?<tag>[a-z][\w-]*)/i.exec(lastSegment);
		if (idMatch?.groups) {
			needle = new RegExp(`id\\s*=\\s*["']${escapeRegExpCharacters(idMatch.groups.id.replace(/\\/g, ''))}["']`);
		} else if (classMatch?.groups) {
			needle = new RegExp(`class\\s*=\\s*["'][^"']*\\b${escapeRegExpCharacters(classMatch.groups.cls.replace(/\\/g, ''))}\\b`);
		} else if (tagMatch?.groups) {
			needle = new RegExp(`<${escapeRegExpCharacters(tagMatch.groups.tag)}[\\s>]`, 'i');
		}
		if (!needle) {
			return undefined;
		}
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			if (needle.test(lines[i])) {
				return i + 1;
			}
		}
		return undefined;
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
		this._browser.value?.setInspectSupported(status.state === 'running' && status.kind === VibeServerRuntimeKind.static);
		this._onDidChangeStatus.fire();
	}
}

registerSingleton(IVibeServerService, VibeServerService, InstantiationType.Delayed);
