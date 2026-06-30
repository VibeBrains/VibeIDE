/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Runtime-provider spine for Vibe Server. A runtime owns one preview-backing process:
 * it starts, reports a URL, streams logs and stops. Phase 0 ships {@link StaticRuntime};
 * Dev-server and Docker runtimes (roadmap VS.4 / VS.5) implement the same contract so the
 * orchestrator and UI stay unchanged.
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { extname, joinPath } from '../../../../../base/common/resources.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService, FileChangesEvent } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IVibeServerMain, IVibeServerStarted, VibeServerChangeKind, VibeServerRuntimeKind } from '../../common/vibeServer/vibeServerIpc.js';
import { IVibeServerProcessMain } from '../../common/vibeServer/vibeServerProcessIpc.js';
import { VibeServerConfigKeys } from './vibeServerConstants.js';

export interface IVibeServerRuntime extends Disposable {
	readonly kind: VibeServerRuntimeKind;
	/** Human-readable progress/diagnostic lines (server start, errors). */
	readonly onDidLog: Event<string>;
	/** Starts the runtime and resolves with the address to preview. */
	start(): Promise<IVibeServerStarted>;
	/** Stops the runtime and releases resources. Safe to call more than once. */
	stop(): Promise<void>;
}

/** Default debounce window (ms) for coalescing file-change bursts into one reload. */
const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Static document server: serves a folder over the main-process HTTP server and reloads
 * the preview on file changes. CSS-only edits trigger a hot swap (page state preserved);
 * anything else triggers a full reload.
 */
export class StaticRuntime extends Disposable implements IVibeServerRuntime {

	readonly kind = VibeServerRuntimeKind.static;

	private readonly _onDidLog = this._register(new Emitter<string>());
	readonly onDidLog = this._onDidLog.event;

	private _started: IVibeServerStarted | undefined;
	private _pendingKind: VibeServerChangeKind | undefined;
	private readonly _flush: RunOnceScheduler;

	constructor(
		private readonly _rootUri: URI,
		private readonly _main: IVibeServerMain,
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IUriIdentityService private readonly _uriIdentityService: IUriIdentityService,
	) {
		super();
		const delay = this._number(VibeServerConfigKeys.reloadDebounceMs, DEFAULT_DEBOUNCE_MS, 0, 5000);
		this._flush = this._register(new RunOnceScheduler(() => this._flushChange(), delay));
	}

	async start(): Promise<IVibeServerStarted> {
		const host = this._string(VibeServerConfigKeys.host, '127.0.0.1');
		const port = this._number(VibeServerConfigKeys.port, 5500, 0, 65535);
		const spaFallback = this._string(VibeServerConfigKeys.spaFallback, '');
		const https = this._boolean(VibeServerConfigKeys.https, false);

		this._started = await this._main.start({ rootFsPath: this._rootUri.fsPath, host, port, spaFallback, https });
		this._onDidLog.fire(`Static server: ${this._started.url} (${this._rootUri.fsPath})`);

		// Correlated watchers do not support recursive mode, so a dev tree needs an
		// uncorrelated recursive watch filtered to the document root.
		const excludes = this._stringArray(VibeServerConfigKeys.ignoreFiles);
		this._register(this._fileService.watch(this._rootUri, { recursive: true, excludes }));
		this._register(this._fileService.onDidFilesChange(e => this._onFilesChanged(e)));

		return this._started;
	}

	async stop(): Promise<void> {
		if (!this._started) {
			return;
		}
		this._started = undefined;
		this._onDidLog.fire('Static server stopped.');
		await this._main.stop();
	}

	override dispose(): void {
		void this._main.stop();
		super.dispose();
	}

	private _onFilesChanged(e: FileChangesEvent): void {
		if (!this._started) {
			return;
		}
		const affected = [...e.rawAdded, ...e.rawUpdated, ...e.rawDeleted]
			.filter(resource => this._uriIdentityService.extUri.isEqualOrParent(resource, this._rootUri));
		if (affected.length === 0) {
			return;
		}
		const cssHotReload = this._boolean(VibeServerConfigKeys.cssHotReload, true);
		const cssOnly = cssHotReload && affected.every(resource => extname(resource).toLowerCase() === '.css');
		// Full reload dominates a CSS-only hot swap within the same debounce window.
		if (!cssOnly) {
			this._pendingKind = 'reload';
		} else if (!this._pendingKind) {
			this._pendingKind = 'css';
		}
		this._flush.schedule();
	}

	private _flushChange(): void {
		const kind = this._pendingKind;
		this._pendingKind = undefined;
		if (kind) {
			void this._main.notifyChange(kind);
		}
	}

	private _string(key: string, fallback: string): string {
		const value = this._configurationService.getValue<string>(key);
		return typeof value === 'string' && value.length > 0 ? value : fallback;
	}

	private _stringArray(key: string): string[] {
		const value = this._configurationService.getValue<string[]>(key);
		return Array.isArray(value) ? value.filter(v => typeof v === 'string') : [];
	}

	private _number(key: string, fallback: number, min: number, max: number): number {
		const value = this._configurationService.getValue<number>(key);
		if (typeof value !== 'number' || !isFinite(value)) {
			return fallback;
		}
		return Math.min(max, Math.max(min, Math.round(value)));
	}

	private _boolean(key: string, fallback: boolean): boolean {
		const value = this._configurationService.getValue<boolean>(key);
		return typeof value === 'boolean' ? value : fallback;
	}
}

/** Matches the first loopback dev-server URL a framework prints (Vite/CRA/Next/etc.). */
const DEV_URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d+[^\s'"]*)/i;
const DEFAULT_DEV_TIMEOUT_MS = 60000;

// ESC built via char code so no control byte sits in the source.
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, '');
}

function normalizeDevUrl(url: string): string {
	return url
		.replace('://0.0.0.0', '://127.0.0.1')
		.replace('://[::1]', '://127.0.0.1')
		.replace(/[)\].,]+$/, '');
}

/**
 * Dev-server runtime: runs the project's own dev script (Vite/Next/CRA/Angular/SvelteKit) as a
 * managed child process, parses the loopback URL it prints and previews that. HMR is the
 * framework's job — we do not inject reload, we just host its URL.
 */
export class DevServerRuntime extends Disposable implements IVibeServerRuntime {

	readonly kind = VibeServerRuntimeKind.devServer;

	private readonly _onDidLog = this._register(new Emitter<string>());
	readonly onDidLog = this._onDidLog.event;

	private readonly _session = this._register(new MutableDisposable<DisposableStore>());
	private _id: string | undefined;

	constructor(
		private readonly _rootUri: URI,
		private readonly _proc: IVibeServerProcessMain,
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	async start(): Promise<IVibeServerStarted> {
		const pkg = await this._readPackageJson();
		const script = this._pickScript(pkg);
		if (!script) {
			throw new Error('В package.json не найден скрипт dev/start/serve');
		}
		const command = await this._packageManager();
		const id = generateUuid();
		this._id = id;

		const store = new DisposableStore();
		this._session.value = store;

		let settled = false;
		let resolveUrl!: (url: string) => void;
		let rejectUrl!: (err: Error) => void;
		const urlPromise = new Promise<string>((res, rej) => { resolveUrl = res; rejectUrl = rej; });

		const timer = setTimeout(() => {
			if (!settled) { settled = true; rejectUrl(new Error('Dev-server не сообщил URL вовремя')); }
		}, this._timeoutMs());
		store.add(toDisposable(() => clearTimeout(timer)));

		store.add(this._proc.onDidOutput(o => {
			if (o.id !== id) { return; }
			const clean = stripAnsi(o.data);
			for (const line of clean.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed) { this._onDidLog.fire(trimmed); }
			}
			if (!settled) {
				const match = DEV_URL_RE.exec(clean);
				if (match) { settled = true; resolveUrl(normalizeDevUrl(match[1])); }
			}
		}));
		store.add(this._proc.onDidExit(e => {
			if (e.id !== id) { return; }
			this._onDidLog.fire(`Процесс завершился (код ${e.code}).`);
			if (!settled) { settled = true; rejectUrl(new Error(`Dev-server завершился до готовности (код ${e.code})`)); }
		}));

		this._onDidLog.fire(`${command} run ${script} (${this._rootUri.fsPath})`);
		await this._proc.start({
			id,
			command,
			args: ['run', script],
			cwd: this._rootUri.fsPath,
			env: { BROWSER: 'none', FORCE_COLOR: '0' },
		});

		const url = await urlPromise;
		const parsed = new URL(url);
		const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
		// Hand the bound port to main so termination/orphan-reaping can target the port owner —
		// reliable even after intermediate shells (npm/cmd) exit and detach the worker PID.
		await this._proc.notePort(id, parsed.hostname, port);
		return { host: parsed.hostname, port, url };
	}

	async stop(): Promise<void> {
		this._session.clear();
		const id = this._id;
		this._id = undefined;
		if (id) {
			await this._proc.stop(id);
		}
	}

	override dispose(): void {
		void this.stop();
		super.dispose();
	}

	private async _readPackageJson(): Promise<{ scripts?: Record<string, string> }> {
		const uri = joinPath(this._rootUri, 'package.json');
		try {
			return JSON.parse((await this._fileService.readFile(uri)).value.toString());
		} catch {
			throw new Error('Не удалось прочитать package.json в корне проекта');
		}
	}

	private _pickScript(pkg: { scripts?: Record<string, string> }): string | undefined {
		const scripts = pkg.scripts ?? {};
		const override = this._configurationService.getValue<string>(VibeServerConfigKeys.devScript);
		if (override && typeof scripts[override] === 'string') {
			return override;
		}
		return ['dev', 'start', 'serve'].find(name => typeof scripts[name] === 'string');
	}

	private async _packageManager(): Promise<string> {
		const has = (name: string) => this._fileService.exists(joinPath(this._rootUri, name));
		if (await has('pnpm-lock.yaml')) { return 'pnpm'; }
		if (await has('yarn.lock')) { return 'yarn'; }
		if (await has('bun.lockb')) { return 'bun'; }
		return 'npm';
	}

	private _timeoutMs(): number {
		const value = this._configurationService.getValue<number>(VibeServerConfigKeys.devServerStartTimeoutMs);
		return typeof value === 'number' && value > 0 ? value : DEFAULT_DEV_TIMEOUT_MS;
	}
}
