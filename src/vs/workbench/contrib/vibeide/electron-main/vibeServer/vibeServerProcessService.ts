/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Process runner for Vibe Server (electron-main). Spawns long-running children (framework
 * dev-servers, `docker compose`) and streams their output to the renderer over
 * `VIBE_SERVER_PROCESS_CHANNEL`.
 *
 * Orphan self-repair — the dev-server's identity is its **port**, not the spawned PID.
 * `npm`/`cmd` wrappers routinely exit mid-session and detach the real worker, so a `taskkill /T`
 * on the originally spawned PID misses the live server. Instead:
 *  1. The renderer reports the bound port via {@link notePort}; termination kills whoever owns
 *     that port (plus the spawned PID tree as a fallback).
 *  2. On shutdown the kill runs **synchronously** in `dispose()` (reliably invoked when the
 *     app's disposable store is torn down), so the main process cannot exit before it completes.
 *  3. Port + cwd are persisted to a pidfile; on the next launch any still-alive owner of a
 *     recorded port whose command line still references the project cwd is reaped before a new
 *     server can bind — the cwd check prevents killing an unrelated process on a recycled port.
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join } from '../../../../../base/common/path.js';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IProcessEnvironment, isWindows } from '../../../../../base/common/platform.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { getResolvedShellEnv } from '../../../../../platform/shell/node/shellEnv.js';
import { IVibeServerPortOwner, IVibeServerProcessMain, IVibeServerProcExit, IVibeServerProcOutput, IVibeServerProcSpec } from '../../common/vibeServer/vibeServerProcessIpc.js';

/** Persisted identity of a spawned dev-server, used to reap orphans across launches. */
interface IRecordedProc {
	/** PID of the spawned shell (fallback kill target; may die before the worker). */
	readonly pid: number;
	/** Absolute project dir — required to appear in a live owner's command line before we reap it. */
	readonly cwd: string;
	/** Loopback port the server bound (the primary kill anchor); set once the renderer reports it. */
	port?: number;
	readonly startedAt: number;
}

/** Cap on the one-shot process listing during reap so a hung query never blocks startup. */
const PROCESS_LIST_TIMEOUT_MS = 5000;

export class VibeServerProcessService extends Disposable implements IVibeServerProcessMain {

	private readonly _onDidOutput = this._register(new Emitter<IVibeServerProcOutput>());
	readonly onDidOutput = this._onDidOutput.event;

	private readonly _onDidExit = this._register(new Emitter<IVibeServerProcExit>());
	readonly onDidExit = this._onDidExit.event;

	private readonly _procs = new Map<string, ChildProcess>();
	/** id → persisted identity, mirrored to the pidfile so a crashed session's servers can be reaped later. */
	private readonly _recorded = new Map<string, IRecordedProc>();
	private readonly _pidfile: string;
	/** Resolves once prior-session orphans have been swept; `start()` awaits it before binding a port. */
	private readonly _reaped: Promise<void>;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IEnvironmentMainService private readonly _environmentMainService: IEnvironmentMainService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this._pidfile = join(this._environmentMainService.userDataPath, 'vibeServer.orphans.json');
		this._reaped = this._reapOrphans();
	}

	async start(spec: IVibeServerProcSpec): Promise<void> {
		// Sweep a prior session's leftovers first; otherwise an orphan holding the port silently
		// shifts the new dev-server to a different (and possibly dead) port → blank preview.
		await this._reaped;
		await this.stop(spec.id);
		// GUI-launched apps on macOS/Linux inherit a bare PATH (no nvm/fnm/Homebrew), so `npm`
		// resolves to nothing and the shell exits with 127. Merge the user's login-shell env
		// (cached, no-op on Windows/CLI launches) before spawning. The login shell only helps
		// when the user's profile hooks their Node manager — many setups don't, so well-known
		// Node install locations are appended to PATH as a last resort.
		const shellEnv = await this._resolveShellEnv();
		const env = { ...process.env, ...shellEnv, ...(spec.env ?? {}) };
		if (!isWindows) {
			env.PATH = this._withNodeFallbackDirs(env.PATH ?? '');
		}
		// Pin an explicit toolchain: prepend the requested dirs after the login-shell PATH is
		// resolved, so they take precedence over the ambient one.
		if (spec.pathPrepend && spec.pathPrepend.length > 0) {
			env.PATH = [...spec.pathPrepend, env.PATH ?? ''].filter(Boolean).join(delimiter);
		}
		let child: ChildProcess;
		try {
			child = spawn(spec.command, spec.args.slice(), {
				cwd: spec.cwd,
				env,
				shell: true,
				windowsHide: true,
				detached: !isWindows, // POSIX: own process group so the whole tree can be signalled
			});
		} catch (err) {
			this._log.error('[VibeServerProcess] spawn failed', err);
			throw err;
		}
		this._procs.set(spec.id, child);
		if (child.pid !== undefined) {
			this._record(spec.id, { pid: child.pid, cwd: spec.cwd, startedAt: Date.now() });
		}

		child.stdout?.on('data', (chunk: Buffer) => this._onDidOutput.fire({ id: spec.id, stream: 'stdout', data: chunk.toString() }));
		child.stderr?.on('data', (chunk: Buffer) => this._onDidOutput.fire({ id: spec.id, stream: 'stderr', data: chunk.toString() }));
		child.on('error', err => {
			this._log.warn('[VibeServerProcess] child error', err);
			this._onDidOutput.fire({ id: spec.id, stream: 'stderr', data: String(err) });
		});
		child.on('exit', (code, signal) => {
			this._procs.delete(spec.id);
			this._forget(spec.id);
			this._onDidExit.fire({ id: spec.id, code: code ?? null, signal: signal ?? null });
		});
	}

	/**
	 * Appends existing well-known Node.js install locations (fnm/nvm/volta/Homebrew/nodejs.org)
	 * that PATH is missing. Appended, not prepended, so an explicitly configured PATH wins.
	 */
	private _withNodeFallbackDirs(path: string): string {
		const home = homedir();
		const candidates = [
			join(home, '.local/share/fnm/aliases/default/bin'),
			join(home, 'Library/Application Support/fnm/aliases/default/bin'),
			join(home, '.fnm/aliases/default/bin'),
			this._nvmDefaultBin(home),
			join(home, '.volta/bin'),
			'/opt/homebrew/bin',
			'/usr/local/bin',
		];
		const present = new Set(path.split(delimiter));
		const missing = candidates.filter((dir): dir is string => !!dir && !present.has(dir) && existsSync(dir));
		return missing.length === 0 ? path : [path, ...missing].join(delimiter);
	}

	/** Bin dir of nvm's default alias, or its newest installed version; undefined when nvm is absent. */
	private _nvmDefaultBin(home: string): string | undefined {
		const versionsDir = join(home, '.nvm/versions/node');
		try {
			const alias = readFileSync(join(home, '.nvm/alias/default'), 'utf8').trim();
			const aliased = join(versionsDir, alias.startsWith('v') ? alias : `v${alias}`, 'bin');
			if (existsSync(aliased)) {
				return aliased;
			}
		} catch { /* no default alias — fall through to newest installed */ }
		try {
			const newest = readdirSync(versionsDir)
				.filter(name => /^v\d+\.\d+\.\d+$/.test(name))
				.sort((a, b) => {
					const pa = a.slice(1).split('.').map(Number);
					const pb = b.slice(1).split('.').map(Number);
					return (pb[0] - pa[0]) || (pb[1] - pa[1]) || (pb[2] - pa[2]);
				})[0];
			return newest ? join(versionsDir, newest, 'bin') : undefined;
		} catch {
			return undefined;
		}
	}

	/** Login-shell environment for spawned dev-servers; empty on failure so start still proceeds. */
	private async _resolveShellEnv(): Promise<typeof process.env> {
		try {
			return await getResolvedShellEnv(this._configurationService, this._log, this._environmentMainService.args, process.env as IProcessEnvironment);
		} catch (err) {
			this._log.warn('[VibeServerProcess] could not resolve shell environment', err);
			return {};
		}
	}

	async notePort(id: string, _host: string, port: number): Promise<void> {
		const rec = this._recorded.get(id);
		if (rec) {
			rec.port = port;
			this._flushPidfile();
		}
	}

	async stop(id: string): Promise<void> {
		const child = this._procs.get(id);
		const rec = this._recorded.get(id);
		this._procs.delete(id);
		this._forget(id);
		// Port owner is the reliable target; the spawned PID tree is a fallback for a server that
		// died before reporting its port.
		if (rec?.port !== undefined) {
			await this._killByPort(rec.port);
		}
		if (child?.pid !== undefined) {
			await this._killTreeByPid(child.pid);
		}
	}

	async describePortOwners(port: number): Promise<IVibeServerPortOwner[]> {
		const pids = await this._portOwners(port);
		if (pids.length === 0) {
			return [];
		}
		const live = await this._listLiveProcesses();
		// The main process is shared across windows, so `_recorded` sees every VibeIDE-managed
		// dev-server — match by reported port or by project cwd in the owner's command line.
		const records = [...this._recorded.values()];
		return pids.map(pid => {
			const commandLine = live.get(pid) ?? '';
			const managed = records.find(rec => rec.port === port || (commandLine.length > 0 && commandLine.includes(rec.cwd)));
			return { pid, commandLine, vibeCwd: managed?.cwd };
		});
	}

	async killPort(port: number): Promise<void> {
		this._log.info(`[VibeServerProcess] freeing port ${port} on user request`);
		await this._killByPort(port);
	}

	waitForPort(host: string, port: number, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		return new Promise<boolean>(resolve => {
			const attempt = () => {
				const socket = net.connect({ host, port });
				socket.once('connect', () => { socket.destroy(); resolve(true); });
				socket.once('error', () => {
					socket.destroy();
					if (Date.now() >= deadline) {
						resolve(false);
					} else {
						setTimeout(attempt, 300);
					}
				});
			};
			attempt();
		});
	}

	waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const isHttps = url.startsWith('https:');
		const request = isHttps ? https.request : http.request;
		return new Promise<boolean>(resolve => {
			const attempt = () => {
				const retryOrFail = () => {
					if (Date.now() >= deadline) {
						resolve(false);
					} else {
						setTimeout(attempt, 300);
					}
				};
				let req: http.ClientRequest;
				try {
					// `rejectUnauthorized: false` — dev servers commonly serve self-signed TLS.
					req = request(url, { method: 'GET', rejectUnauthorized: false } as http.RequestOptions, res => {
						res.resume(); // drain so the socket frees
						const status = res.statusCode ?? 0;
						if (status >= 200 && status < 500) {
							resolve(true);
						} else {
							retryOrFail();
						}
					});
				} catch {
					return retryOrFail();
				}
				req.once('error', () => retryOrFail());
				// A hung connect must not outlive the poll interval.
				req.setTimeout(2000, () => req.destroy());
				req.end();
			};
			attempt();
		});
	}

	override dispose(): void {
		// Runs synchronously when the app's disposable store is torn down on shutdown, so the main
		// process cannot exit before the kill completes (the async path used to lose that race).
		for (const rec of this._recorded.values()) {
			if (rec.port !== undefined) {
				this._killByPortSync(rec.port);
			}
			this._killTreeByPidSync(rec.pid);
		}
		this._recorded.clear();
		this._procs.clear();
		this._clearPidfile();
		super.dispose();
	}

	// --- termination ------------------------------------------------------------------------

	private async _killByPort(port: number): Promise<void> {
		for (const pid of await this._portOwners(port)) {
			await this._killTreeByPid(pid);
		}
	}

	private _killByPortSync(port: number): void {
		for (const pid of this._portOwnersSync(port)) {
			this._killTreeByPidSync(pid);
		}
	}

	private _killTreeByPid(pid: number): Promise<void> {
		return new Promise<void>(resolve => {
			if (isWindows) {
				try {
					const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
					tk.once('exit', () => resolve());
					tk.once('error', () => resolve());
				} catch {
					resolve();
				}
			} else {
				try {
					process.kill(-pid, 'SIGTERM'); // negative pid → whole process group
				} catch {
					try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
				}
				resolve();
			}
		});
	}

	private _killTreeByPidSync(pid: number): void {
		try {
			if (isWindows) {
				spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
			} else {
				try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
			}
		} catch { /* already gone */ }
	}

	// --- port → owner PID lookup ------------------------------------------------------------

	private async _portOwners(port: number): Promise<number[]> {
		if (isWindows) {
			return this._extractWindowsOwners(await this._capture('netstat', ['-ano', '-p', 'tcp']), port);
		}
		return this._extractPids(await this._capture('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']));
	}

	private _portOwnersSync(port: number): number[] {
		try {
			if (isWindows) {
				const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
				return this._extractWindowsOwners(r.stdout ?? '', port);
			}
			const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
			return this._extractPids(r.stdout ?? '');
		} catch {
			return [];
		}
	}

	private _extractWindowsOwners(stdout: string, port: number): number[] {
		const owners = new Set<number>();
		for (const line of stdout.split(/\r?\n/)) {
			const parts = line.trim().split(/\s+/); // Proto, Local, Foreign, State, PID
			if (parts[0] !== 'TCP' || parts[3] !== 'LISTENING' || !parts[1]?.endsWith(`:${port}`)) {
				continue;
			}
			const pid = Number(parts[4]);
			if (pid > 0) {
				owners.add(pid);
			}
		}
		return [...owners];
	}

	private _extractPids(stdout: string): number[] {
		const pids = new Set<number>();
		for (const line of stdout.split(/\r?\n/)) {
			const pid = Number(line.trim());
			if (pid > 0) {
				pids.add(pid);
			}
		}
		return [...pids];
	}

	// --- orphan persistence + reaping -------------------------------------------------------

	private _record(id: string, rec: IRecordedProc): void {
		this._recorded.set(id, rec);
		this._flushPidfile();
	}

	private _forget(id: string): void {
		if (this._recorded.delete(id)) {
			this._flushPidfile();
		}
	}

	private _flushPidfile(): void {
		try {
			const data = JSON.stringify([...this._recorded.values()]);
			const tmp = `${this._pidfile}.tmp`;
			writeFileSync(tmp, data, 'utf8');
			renameSync(tmp, this._pidfile); // atomic replace so a crash mid-write cannot corrupt the file
		} catch (err) {
			this._log.warn('[VibeServerProcess] could not persist pidfile', err);
		}
	}

	private _clearPidfile(): void {
		try {
			if (existsSync(this._pidfile)) {
				unlinkSync(this._pidfile);
			}
		} catch { /* best-effort */ }
	}

	/** Kills any still-alive owner of a recorded port whose command line still references the project cwd. */
	private async _reapOrphans(): Promise<void> {
		let recorded: IRecordedProc[];
		try {
			const parsed = JSON.parse(readFileSync(this._pidfile, 'utf8'));
			recorded = Array.isArray(parsed) ? parsed : [];
		} catch {
			return; // no/invalid pidfile → nothing to reap
		}
		if (recorded.length === 0) {
			this._clearPidfile();
			return;
		}
		const live = await this._listLiveProcesses();
		for (const entry of recorded) {
			if (!entry || typeof entry.cwd !== 'string') {
				continue;
			}
			// Prefer the port owner; fall back to the recorded PID when the port was never reported.
			const candidates = entry.port !== undefined ? await this._portOwners(entry.port) : [];
			if (candidates.length === 0 && typeof entry.pid === 'number') {
				candidates.push(entry.pid);
			}
			for (const pid of candidates) {
				const cmd = live.get(pid);
				if (cmd === undefined || !cmd.includes(entry.cwd)) {
					continue; // already gone, or PID/port recycled by an unrelated process — leave it
				}
				this._log.info(`[VibeServerProcess] reaping orphaned dev-server pid=${pid} port=${entry.port ?? '?'} (${entry.cwd})`);
				await this._killTreeByPid(pid);
			}
		}
		this._clearPidfile();
	}

	/** One-shot snapshot of live processes as PID → command line, for the reap cwd check. */
	private _listLiveProcesses(): Promise<Map<number, string>> {
		const result = new Map<number, string>();
		const command = isWindows ? 'powershell.exe' : 'ps';
		const args = isWindows
			? ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }']
			: ['-eo', 'pid=,args='];
		return new Promise<Map<number, string>>(resolve => {
			let settled = false;
			const finish = () => { if (!settled) { settled = true; resolve(result); } };
			let proc: ChildProcess;
			try {
				proc = spawn(command, args, { windowsHide: true });
			} catch {
				return finish();
			}
			const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(); }, PROCESS_LIST_TIMEOUT_MS);
			let out = '';
			proc.stdout?.on('data', (chunk: Buffer) => out += chunk.toString());
			proc.once('error', () => { clearTimeout(timer); finish(); });
			proc.once('close', () => {
				clearTimeout(timer);
				for (const line of out.split(/\r?\n/)) {
					const m = isWindows ? /^(\d+)\t(.*)$/.exec(line) : /^\s*(\d+)\s+(.*)$/.exec(line);
					if (m) {
						result.set(Number(m[1]), m[2]);
					}
				}
				finish();
			});
		});
	}

	/** Captures stdout of a short-lived command (best-effort; empty on failure/timeout). */
	private _capture(command: string, args: readonly string[]): Promise<string> {
		return new Promise<string>(resolve => {
			let settled = false;
			const finish = (out: string) => { if (!settled) { settled = true; resolve(out); } };
			let proc: ChildProcess;
			try {
				proc = spawn(command, args.slice(), { windowsHide: true });
			} catch {
				return finish('');
			}
			const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } finish(''); }, PROCESS_LIST_TIMEOUT_MS);
			let out = '';
			proc.stdout?.on('data', (chunk: Buffer) => out += chunk.toString());
			proc.once('error', () => { clearTimeout(timer); finish(''); });
			proc.once('close', () => { clearTimeout(timer); finish(out); });
		});
	}
}
