/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Docker runtime (roadmap VS.5): brings up the project's environment for preview.
 * Supports `docker compose` (preferred) and a lone `Dockerfile` (build + run). Discovers the
 * published web port, waits until it actually answers, streams container logs, and tears the
 * environment down on stop. Scope is "spin up a runtime to preview it" — not Dev Containers.
 */

import { localize } from '../../../../../nls.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IVibeServerProcessMain, IVibeServerProcSpec } from '../../common/vibeServer/vibeServerProcessIpc.js';
import { IVibeServerStarted, VibeServerRuntimeKind } from '../../common/vibeServer/vibeServerIpc.js';
import { IVibeServerRuntime } from './vibeServerRuntime.js';
import { VibeServerConfigKeys } from './vibeServerConstants.js';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const PORT_PREFERENCE = [80, 8080, 3000, 5000, 8000, 4200, 5173, 3001];
const DEFAULT_DOCKER_TIMEOUT_MS = 120000;
const LOOPBACK = '127.0.0.1';

interface IRunResult {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

/** Runs a one-shot command through the process runner and resolves with its full output. */
function runToCompletion(proc: IVibeServerProcessMain, spec: IVibeServerProcSpec): Promise<IRunResult> {
	return new Promise<IRunResult>(resolve => {
		const store = new DisposableStore();
		let stdout = '';
		let stderr = '';
		store.add(proc.onDidOutput(o => {
			if (o.id !== spec.id) { return; }
			if (o.stream === 'stdout') { stdout += o.data; } else { stderr += o.data; }
		}));
		store.add(proc.onDidExit(e => {
			if (e.id !== spec.id) { return; }
			store.dispose();
			resolve({ code: e.code, stdout, stderr });
		}));
		proc.start(spec).catch(err => { store.dispose(); resolve({ code: null, stdout, stderr: String(err) }); });
	});
}

function parsePublishedPorts(text: string): number[] {
	const ports = new Set<number>();
	const consume = (entry: unknown) => {
		const publishers = (entry as { Publishers?: Array<{ PublishedPort?: number }> })?.Publishers;
		if (Array.isArray(publishers)) {
			for (const p of publishers) {
				const hostPort = Number(p?.PublishedPort);
				if (hostPort > 0) { ports.add(hostPort); }
			}
		}
	};
	const trimmed = text.trim();
	if (!trimmed) { return []; }
	try {
		const parsed = JSON.parse(trimmed);
		if (Array.isArray(parsed)) { parsed.forEach(consume); } else { consume(parsed); }
	} catch {
		for (const line of trimmed.split(/\r?\n/)) {
			try { consume(JSON.parse(line)); } catch { /* skip non-JSON line */ }
		}
	}
	return [...ports];
}

function parseYamlPorts(text: string): number[] {
	const ports = new Set<number>();
	// `- "8080:80"`, `- 3000:3000`, or `- "127.0.0.1:8080:80"` (optional host-ip prefix).
	const re = /-\s*["']?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d+):\d+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) { ports.add(Number(m[1])); }
	return [...ports];
}

function pickPort(ports: number[]): number | undefined {
	for (const preferred of PORT_PREFERENCE) {
		if (ports.includes(preferred)) { return preferred; }
	}
	return ports[0];
}

function parseDockerPort(text: string): number | undefined {
	const m = /->\s*[\d.]+:(\d+)/.exec(text);
	return m ? Number(m[1]) : undefined;
}

export class DockerRuntime extends Disposable implements IVibeServerRuntime {

	readonly kind = VibeServerRuntimeKind.docker;

	private readonly _onDidLog = this._register(new Emitter<string>());
	readonly onDidLog = this._onDidLog.event;

	private readonly _logSession = this._register(new MutableDisposable<DisposableStore>());
	private _logId: string | undefined;
	private _mode: 'compose' | 'dockerfile' | undefined;
	private _containerName: string | undefined;

	constructor(
		private readonly _rootUri: URI,
		private readonly _proc: IVibeServerProcessMain,
		@IFileService private readonly _fileService: IFileService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	async start(): Promise<IVibeServerStarted> {
		await this._assertDockerAvailable();
		const composeFile = await this._findComposeFile();
		if (composeFile) {
			return this._startCompose();
		}
		if (await this._exists('Dockerfile')) {
			return this._startDockerfile();
		}
		throw new Error(localize('vibeide.dockerRuntime.noComposeOrDockerfile', "В корне проекта нет docker-compose.yml или Dockerfile"));
	}

	async stop(): Promise<void> {
		if (this._logId) {
			await this._proc.stop(this._logId);
			this._logId = undefined;
		}
		this._logSession.clear();
		if (this._mode === 'compose') {
			await runToCompletion(this._proc, this._spec(['compose', 'down']));
		} else if (this._mode === 'dockerfile' && this._containerName) {
			await runToCompletion(this._proc, this._spec(['rm', '-f', this._containerName]));
		}
		this._mode = undefined;
		this._containerName = undefined;
	}

	override dispose(): void {
		void this.stop();
		super.dispose();
	}

	private async _startCompose(): Promise<IVibeServerStarted> {
		this._onDidLog.fire('docker compose up -d --build…');
		const up = await runToCompletion(this._proc, this._spec(['compose', 'up', '-d', '--build']));
		if (up.code !== 0) {
			throw new Error(`docker compose up завершился с ошибкой: ${(up.stderr || up.stdout).trim().slice(-400)}`);
		}
		this._mode = 'compose';

		const ps = await runToCompletion(this._proc, this._spec(['compose', 'ps', '--format', 'json']));
		let ports = parsePublishedPorts(ps.stdout);
		if (ports.length === 0) {
			const composeUri = await this._findComposeFile();
			if (composeUri) {
				ports = parseYamlPorts((await this._fileService.readFile(composeUri)).value.toString());
			}
		}
		const port = pickPort(ports);
		if (!port) {
			throw new Error(localize('vibeide.dockerRuntime.noPublishedPort', "Не удалось определить опубликованный порт контейнера"));
		}

		await this._awaitReady(port);
		this._streamLogs(['compose', 'logs', '-f', '--no-color']);
		return this._started(port);
	}

	private async _startDockerfile(): Promise<IVibeServerStarted> {
		const tag = `vibe-server/${this._shortId()}`;
		const name = `vibe-server-${this._shortId()}`;
		this._onDidLog.fire(`docker build -t ${tag} .…`);
		const build = await runToCompletion(this._proc, this._spec(['build', '-t', tag, '.']));
		if (build.code !== 0) {
			throw new Error(`docker build завершился с ошибкой: ${(build.stderr || build.stdout).trim().slice(-400)}`);
		}
		const run = await runToCompletion(this._proc, this._spec(['run', '-d', '-P', '--name', name, tag]));
		if (run.code !== 0) {
			throw new Error(`docker run завершился с ошибкой: ${(run.stderr || run.stdout).trim().slice(-400)}`);
		}
		this._mode = 'dockerfile';
		this._containerName = name;

		const portInfo = await runToCompletion(this._proc, this._spec(['port', name]));
		const port = parseDockerPort(portInfo.stdout);
		if (!port) {
			throw new Error(localize('vibeide.dockerRuntime.containerNoPort', "Контейнер не опубликовал ни одного порта (нет EXPOSE/-p)"));
		}

		await this._awaitReady(port);
		this._streamLogs(['logs', '-f', name]);
		return this._started(port);
	}

	private async _awaitReady(port: number): Promise<void> {
		this._onDidLog.fire(`Ожидание готовности порта ${port}…`);
		const ready = await this._proc.waitForPort(LOOPBACK, port, this._timeoutMs());
		if (!ready) {
			throw new Error(`Порт ${port} не ответил за отведённое время`);
		}
	}

	/** Starts a detached `... -f` log follower whose output is forwarded to the log channel. */
	private _streamLogs(args: string[]): void {
		const id = generateUuid();
		this._logId = id;
		const store = new DisposableStore();
		this._logSession.value = store;
		store.add(this._proc.onDidOutput(o => {
			if (o.id !== id) { return; }
			for (const line of o.data.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed) { this._onDidLog.fire(trimmed); }
			}
		}));
		this._proc.start(this._spec(args, id)).catch(() => { /* log follower is best-effort */ });
	}

	private async _assertDockerAvailable(): Promise<void> {
		const result = await runToCompletion(this._proc, this._spec(['version']));
		if (result.code !== 0) {
			throw new Error(localize('vibeide.dockerRuntime.dockerUnavailable', "Docker недоступен — установите и запустите Docker Desktop"));
		}
	}

	private async _findComposeFile(): Promise<URI | undefined> {
		for (const name of COMPOSE_FILES) {
			if (await this._exists(name)) {
				return joinPath(this._rootUri, name);
			}
		}
		return undefined;
	}

	private _exists(name: string): Promise<boolean> {
		return this._fileService.exists(joinPath(this._rootUri, name));
	}

	private _started(port: number): IVibeServerStarted {
		const url = `http://${LOOPBACK}:${port}/`;
		this._onDidLog.fire(`Окружение поднято: ${url}`);
		return { host: LOOPBACK, port, url };
	}

	private _spec(args: string[], id: string = generateUuid()): IVibeServerProcSpec {
		return { id, command: 'docker', args, cwd: this._rootUri.fsPath };
	}

	private _shortId(): string {
		return generateUuid().slice(0, 8);
	}

	private _timeoutMs(): number {
		const value = this._configurationService.getValue<number>(VibeServerConfigKeys.dockerStartTimeoutMs);
		return typeof value === 'number' && value > 0 ? value : DEFAULT_DOCKER_TIMEOUT_MS;
	}
}
