/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IVibeServerStackService` (contract in
 * `../../browser/vibeServer/vibeServerStackService.ts`).
 *
 * Reads `.vibe/servers.json`, then drives each entry through the process channel
 * (`VIBE_SERVER_PROCESS_CHANNEL`) — the same runner the single-server path uses, keyed by id so
 * several dev-servers run at once. `dependsOn` ordering comes from the pure core
 * (`planStartOrder` over `selectWithDependencies`); this layer only spawns, probes readiness and
 * tracks per-entry state. `IMainProcessService` is banned in `common/**` and `browser/**`, which is
 * why the implementation lives here.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts`.
 */

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IVibeServerProcessMain, IVibeServerProcSpec, VIBE_SERVER_PROCESS_CHANNEL } from '../../common/vibeServer/vibeServerProcessIpc.js';
import {
	VibeServerEntry,
	effectiveReadyCheck,
	effectiveReadyTimeoutMs,
	parseServersFile,
	planStartOrder,
	selectWithDependencies,
} from '../../common/vibeServer/vibeServersFile.js';
import { VibeServerConfigKeys } from '../../browser/vibeServer/vibeServerConstants.js';
import { IVibeServerStackService, IVibeServerStackEntry, VibeServerEntryState } from '../../browser/vibeServer/vibeServerStackService.js';

/** Host every managed dev-server is probed on (services declare only a port). */
const LOOPBACK_HOST = 'localhost';

/** Mutable per-entry status the orchestrator maintains; the readonly view is exposed to the UI. */
interface IEntryStatus {
	readonly entry: VibeServerEntry;
	state: VibeServerEntryState;
	url?: string;
	detail?: string;
}

class VibeServerStackService extends Disposable implements IVibeServerStackService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeStack = this._register(new Emitter<void>());
	readonly onDidChangeStack = this._onDidChangeStack.event;

	private readonly _procMain: IVibeServerProcessMain;

	private _available = false;
	private _warnings: readonly string[] = [];
	/** id → status, in file order (Map preserves insertion order). */
	private _statuses = new Map<string, IEntryStatus>();
	/** Guards concurrent start/stop of the same entry. */
	private readonly _inFlight = new Set<string>();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._procMain = ProxyChannel.toService<IVibeServerProcessMain>(mainProcessService.getChannel(VIBE_SERVER_PROCESS_CHANNEL));
		// A running service that dies on its own (crash, killed externally) drops back to stopped so
		// the UI stops claiming it is up. `starting` is owned by the readiness waiter; `stopped`
		// entries we set before stopping, so a self-inflicted stop never trips this.
		this._register(this._procMain.onDidExit(e => {
			const status = this._statuses.get(e.id);
			if (status && status.state === 'running') {
				status.state = 'stopped';
				status.url = undefined;
				this._onDidChangeStack.fire();
			}
		}));
	}

	get available(): boolean {
		return this._available;
	}

	get warnings(): readonly string[] {
		return this._warnings;
	}

	get entries(): readonly IVibeServerStackEntry[] {
		return [...this._statuses.values()].map(s => ({ entry: s.entry, state: s.state, url: s.url, detail: s.detail }));
	}

	async reload(): Promise<void> {
		const fileUri = this._serversFileUri();
		let content: string | undefined;
		if (fileUri) {
			try {
				content = (await this._fileService.readFile(fileUri)).value.toString();
			} catch {
				content = undefined; // absent file → single-server behaviour, not an error
			}
		}
		if (content === undefined) {
			this._available = false;
			this._warnings = [];
			this._statuses = new Map();
			this._onDidChangeStack.fire();
			return;
		}

		const parsed = parseServersFile(content);
		if (!parsed.ok) {
			this._available = false;
			this._warnings = parsed.error ? [parsed.error] : [];
			this._statuses = new Map();
			this._notificationService.warn(localize('vibeStack.parseError', "Не удалось разобрать .vibe/servers.json: {0}", parsed.error ?? ""));
			this._onDidChangeStack.fire();
			return;
		}

		// Preserve the live state of entries that survive a reload (same id) so re-reading the file
		// while servers run does not visually reset them to stopped.
		const previous = this._statuses;
		const next = new Map<string, IEntryStatus>();
		for (const entry of parsed.servers) {
			const prior = previous.get(entry.id);
			next.set(entry.id, prior
				? { entry, state: prior.state, url: prior.url, detail: prior.detail }
				: { entry, state: 'stopped' });
		}
		this._statuses = next;
		this._available = true;
		this._warnings = parsed.warnings;
		this._onDidChangeStack.fire();
	}

	async startEntry(id: string): Promise<void> {
		if (!this._available) {
			await this.reload();
		}
		const target = this._statuses.get(id);
		if (!target) {
			return;
		}
		const all = [...this._statuses.values()].map(s => s.entry);
		const plan = planStartOrder(selectWithDependencies(all, id));

		// Mark entries the plan refuses to start (broken/cyclic dependencies) so the UI can explain
		// why nothing happened instead of leaving the row silent.
		for (const { id: exId, reason } of plan.excluded) {
			this._setState(exId, 'excluded', undefined, reason);
		}
		if (plan.excluded.some(e => e.id === id)) {
			this._notificationService.warn(localize('vibeStack.cannotStart', "«{0}» нельзя запустить: {1}", id, plan.excluded.find(e => e.id === id)!.reason));
			return;
		}

		for (const wave of plan.waves) {
			const results = await Promise.all(wave.map(wid => this._startOne(this._statuses.get(wid)!.entry)));
			const failed = wave.filter((_, i) => !results[i]);
			if (failed.length > 0) {
				// A prerequisite did not come up — starting later waves would launch a service without
				// its dependency, the exact failure dependsOn exists to prevent.
				this._notificationService.error(localize('vibeStack.waveFailed', "Не удалось поднять: {0}. Запуск зависимых остановлен.", failed.join(", ")));
				return;
			}
		}
	}

	async startAll(): Promise<void> {
		if (!this._available) {
			await this.reload();
		}
		const all = [...this._statuses.values()].map(s => s.entry);
		const plan = planStartOrder(all);
		for (const { id, reason } of plan.excluded) {
			this._setState(id, 'excluded', undefined, reason);
		}
		for (const wave of plan.waves) {
			const results = await Promise.all(wave.map(wid => this._startOne(this._statuses.get(wid)!.entry)));
			if (results.some(ok => !ok)) {
				this._notificationService.error(localize('vibeStack.startAllFailed', "Часть сервисов стека не поднялась — запуск зависимых остановлен."));
				return;
			}
		}
	}

	async stopEntry(id: string): Promise<void> {
		const status = this._statuses.get(id);
		if (!status || this._inFlight.has(id)) {
			return;
		}
		this._inFlight.add(id);
		try {
			// Set stopped first so the self-exit listener treats the incoming exit as expected.
			this._setState(id, 'stopped', undefined, undefined);
			await this._procMain.stop(id);
			if (status.entry.stopCommand) {
				await this._runToCompletion(`${id}::stop`, status.entry.stopCommand, status.entry);
			}
		} finally {
			this._inFlight.delete(id);
		}
	}

	async stopAll(): Promise<void> {
		const ids = [...this._statuses.values()]
			.filter(s => s.state === 'running' || s.state === 'starting')
			.map(s => s.entry.id);
		await Promise.all(ids.map(id => this.stopEntry(id)));
	}

	previewUrlFor(id: string): string | undefined {
		const status = this._statuses.get(id);
		if (!status || status.state !== 'running' || !status.url) {
			return undefined;
		}
		const previewPath = status.entry.previewPath;
		return previewPath ? status.url + (previewPath.startsWith('/') ? previewPath : `/${previewPath}`) : status.url;
	}

	// --- start one entry --------------------------------------------------------------------

	/** Starts a single entry and waits for its readiness. Returns whether it became ready. */
	private async _startOne(entry: VibeServerEntry): Promise<boolean> {
		const status = this._statuses.get(entry.id);
		if (!status) {
			return false;
		}
		if (status.state === 'running') {
			return true; // already up (shared dependency of a sibling) — nothing to do
		}
		if (this._inFlight.has(entry.id)) {
			return false; // another wave/caller is already bringing this entry up
		}
		this._inFlight.add(entry.id);
		try {
			// `skipIf` short-circuits a task that is already satisfied (e.g. `docker info` before
			// starting the daemon): a zero exit means "nothing to do", count it ready.
			if (entry.skipIf && await this._probeSucceeds(entry.skipIf, entry)) {
				this._setState(entry.id, 'running', undefined, localize('vibeStack.skipped', "Пропущен: условие skipIf уже выполнено"));
				return true;
			}

			const spec = await this._buildSpec(entry);
			this._setState(entry.id, 'starting', undefined, undefined);
			try {
				await this._procMain.start(spec);
			} catch (err) {
				this._setState(entry.id, 'failed', undefined, String(err));
				return false;
			}
			if (typeof entry.port === 'number') {
				// Lets termination target the port owner even when a wrapper shell detaches the worker.
				void this._procMain.notePort(entry.id, LOOPBACK_HOST, entry.port);
			}

			const ready = await this._waitForReady(entry);
			if (ready.ok) {
				const url = typeof entry.port === 'number' ? `http://${LOOPBACK_HOST}:${entry.port}` : undefined;
				this._setState(entry.id, 'running', url, undefined);
				return true;
			}
			this._setState(entry.id, 'failed', undefined, ready.detail);
			await this._procMain.stop(entry.id); // do not leave a half-started process behind
			return false;
		} finally {
			this._inFlight.delete(entry.id);
		}
	}

	private async _buildSpec(entry: VibeServerEntry): Promise<IVibeServerProcSpec> {
		const root = this._resolveRoot();
		const cwd = (root ? (entry.dir ? joinPath(root, entry.dir) : root) : undefined)?.fsPath ?? '';
		return {
			id: entry.id,
			command: entry.command,
			args: [],
			cwd,
			env: await this._buildEnv(entry, root),
			pathPrepend: entry.pathPrepend,
		};
	}

	private async _buildEnv(entry: VibeServerEntry, root: URI | undefined): Promise<Record<string, string> | undefined> {
		const env: Record<string, string> = { ...(entry.env ?? {}) };
		if (entry.envFile && root) {
			const base = entry.dir ? joinPath(root, entry.dir) : root;
			try {
				const raw = (await this._fileService.readFile(joinPath(base, entry.envFile))).value.toString();
				Object.assign(env, parseDotEnv(raw));
			} catch (err) {
				this._logService.warn(`[VibeServerStack] could not read envFile for "${entry.id}"`, err);
			}
		}
		return Object.keys(env).length > 0 ? env : undefined;
	}

	// --- readiness --------------------------------------------------------------------------

	private async _waitForReady(entry: VibeServerEntry): Promise<{ ok: boolean; detail?: string }> {
		const check = effectiveReadyCheck(entry);
		const timeoutMs = effectiveReadyTimeoutMs(entry);
		switch (check) {
			case 'spawn':
				return { ok: true };
			case 'exit': {
				const code = await this._awaitExit(entry.id, timeoutMs);
				if (code === 0) {
					return { ok: true };
				}
				return { ok: false, detail: code === null ? localize('vibeStack.timeout', "истекло время ожидания готовности") : localize('vibeStack.exitCode', "команда завершилась с кодом {0}", code) };
			}
			case 'port': {
				if (typeof entry.port !== 'number') {
					return { ok: false, detail: localize('vibeStack.noPort', "readyCheck \"port\" без указанного порта") };
				}
				const ok = await this._procMain.waitForPort(LOOPBACK_HOST, entry.port, timeoutMs);
				return { ok, detail: ok ? undefined : localize('vibeStack.portTimeout', "порт {0} не открылся за отведённое время", entry.port) };
			}
			case 'http': {
				if (typeof entry.port !== 'number') {
					return { ok: false, detail: localize('vibeStack.httpNoPort', "readyCheck \"http\" без указанного порта") };
				}
				const path = entry.readyPath ?? '/';
				const url = `http://${LOOPBACK_HOST}:${entry.port}${path.startsWith('/') ? path : `/${path}`}`;
				const ok = await this._procMain.waitForHttp(url, timeoutMs);
				return { ok, detail: ok ? undefined : localize('vibeStack.httpTimeout', "HTTP-проба {0} не прошла за отведённое время", url) };
			}
			case 'log': {
				if (!entry.readyPattern) {
					return { ok: false, detail: localize('vibeStack.noPattern', "readyCheck \"log\" без readyPattern") };
				}
				const ok = await this._awaitLog(entry.id, entry.readyPattern, timeoutMs);
				return { ok, detail: ok ? undefined : localize('vibeStack.logTimeout', "шаблон готовности не появился в выводе за отведённое время") };
			}
			default:
				return { ok: true };
		}
	}

	/** Resolves with the exit code (null on timeout) for the process with the given id. */
	private _awaitExit(id: string, timeoutMs: number): Promise<number | null> {
		return new Promise<number | null>(resolve => {
			const store = new DisposableStore();
			const timer = setTimeout(() => { store.dispose(); resolve(null); }, timeoutMs);
			store.add({ dispose: () => clearTimeout(timer) });
			store.add(this._procMain.onDidExit(e => {
				if (e.id === id) {
					store.dispose();
					resolve(e.code);
				}
			}));
		});
	}

	/** Resolves true when `pattern` matches a line of the process output before the timeout. */
	private _awaitLog(id: string, pattern: string, timeoutMs: number): Promise<boolean> {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern);
		} catch {
			return Promise.resolve(false); // invalid pattern can never match
		}
		return new Promise<boolean>(resolve => {
			const store = new DisposableStore();
			let buffer = '';
			const timer = setTimeout(() => { store.dispose(); resolve(false); }, timeoutMs);
			store.add({ dispose: () => clearTimeout(timer) });
			const settle = (ok: boolean) => { store.dispose(); resolve(ok); };
			store.add(this._procMain.onDidOutput(e => {
				if (e.id !== id) {
					return;
				}
				buffer += e.data;
				const newlineIndex = buffer.lastIndexOf('\n');
				const complete = newlineIndex >= 0 ? buffer.slice(0, newlineIndex) : '';
				if (regex.test(complete)) {
					settle(true);
				}
				// Keep only the trailing partial line so the buffer cannot grow without bound.
				if (newlineIndex >= 0) {
					buffer = buffer.slice(newlineIndex + 1);
				}
			}));
			store.add(this._procMain.onDidExit(e => {
				if (e.id === id) {
					settle(false); // died before the pattern appeared
				}
			}));
		});
	}

	// --- probe / one-shot commands ----------------------------------------------------------

	/** Runs a probe command and reports whether it exited 0 (used by `skipIf`). */
	private async _probeSucceeds(command: string, entry: VibeServerEntry): Promise<boolean> {
		return (await this._runToCompletion(`${entry.id}::skipIf`, command, entry)) === 0;
	}

	/** Spawns a short-lived command under the entry's cwd/env and resolves with its exit code. */
	private async _runToCompletion(procId: string, command: string, entry: VibeServerEntry): Promise<number | null> {
		const root = this._resolveRoot();
		const cwd = (root ? (entry.dir ? joinPath(root, entry.dir) : root) : undefined)?.fsPath ?? '';
		const done = this._awaitExit(procId, effectiveReadyTimeoutMs(entry));
		try {
			await this._procMain.start({ id: procId, command, args: [], cwd, env: await this._buildEnv(entry, root), pathPrepend: entry.pathPrepend });
		} catch {
			return null;
		}
		return done;
	}

	// --- helpers ----------------------------------------------------------------------------

	private _setState(id: string, state: VibeServerEntryState, url: string | undefined, detail: string | undefined): void {
		const status = this._statuses.get(id);
		if (!status) {
			return;
		}
		status.state = state;
		status.url = url;
		status.detail = detail;
		this._onDidChangeStack.fire();
	}

	private _serversFileUri(): URI | undefined {
		const root = this._resolveRoot();
		return root ? joinPath(root, '.vibe', 'servers.json') : undefined;
	}

	/** Workspace root, honouring the `vibeide.vibeServer.root` sub-directory setting. */
	private _resolveRoot(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		const base = folders[0].uri;
		const relative = this._configurationService.getValue<string>(VibeServerConfigKeys.root);
		return relative && relative.trim().length > 0 ? joinPath(base, relative.trim()) : base;
	}

	override dispose(): void {
		// Best-effort teardown of everything this session started.
		for (const status of this._statuses.values()) {
			if (status.state === 'running' || status.state === 'starting') {
				void this._procMain.stop(status.entry.id);
			}
		}
		super.dispose();
	}
}

/** Minimal `.env` parser: `KEY=VALUE` lines, `#` comments and blanks ignored, surrounding quotes stripped. */
function parseDotEnv(raw: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			continue;
		}
		const eq = trimmed.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

registerSingleton(IVibeServerStackService, VibeServerStackService, InstantiationType.Delayed);
