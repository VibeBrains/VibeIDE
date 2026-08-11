/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { spawn } from 'child_process';
import { platform, totalmem } from 'os';
import { connect } from 'net';
import { LocalModelDetails, LocalModelEntry } from '../common/ollamaInstallerService.js';

type InstallParams = { method: 'auto' | 'brew' | 'curl' | 'winget' | 'choco'; modelTag?: string };
export type ProbeResult = { running: boolean; modelCount: number };

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const PROBE_TIMEOUT_MS = 1500;
/** Metadata reads may queue behind generation on a busy server; a probe timeout is too short. */
const REQUEST_TIMEOUT_MS = 5000;

export class OllamaInstallerChannel implements IServerChannel {

	private readonly _onLog = new Emitter<{ text: string }>();
	private readonly _onDone = new Emitter<{ ok: boolean }>();

	listen<T>(_: unknown, event: string): Event<T> {
		if (event === 'onLog') { return this._onLog.event as Event<T>; }
		if (event === 'onDone') { return this._onDone.event as Event<T>; }
		throw new Error(`Event not found: ${event}`);
	}

	async call<T>(_: unknown, command: string, params: unknown): Promise<T> {
		if (command === 'install') {
			this.install(params as InstallParams);
			return undefined as T;
		}
		if (command === 'probe') {
			return (await this.probe()) as T;
		}
		if (command === 'listModels') {
			return (await this.listModels()) as T;
		}
		if (command === 'inspectModel') {
			return (await this.inspectModel(String(params))) as T;
		}
		if (command === 'hostMemoryBytes') {
			return totalmem() as T;
		}
		throw new Error(`Unknown command: ${command}`);
	}

	/**
	 * Models already pulled onto this machine, with their real on-disk size — the term that
	 * dominates the «will this run here?» estimate and the one that need not be guessed.
	 * Ollama being absent is an ordinary answer, not a failure: the caller gets an empty list.
	 */
	private async listModels(): Promise<LocalModelEntry[]> {
		const body = await this.getJson('/api/tags').catch(() => undefined);
		const models = (body as { models?: unknown })?.models;
		if (!Array.isArray(models)) {
			return [];
		}
		return models.flatMap((entry: Record<string, unknown>) => {
			const name = entry?.['name'];
			const size = entry?.['size'];
			if (typeof name !== 'string' || typeof size !== 'number') {
				return [];
			}
			const details = entry['details'] as Record<string, unknown> | undefined;
			const text = (key: string) => typeof details?.[key] === 'string' ? details[key] as string : undefined;
			return [{
				name,
				sizeBytes: size,
				quantization: text('quantization_level'),
				parameterSize: text('parameter_size'),
			}];
		});
	}

	/**
	 * `model_info` is handed over untouched: its keys carry the architecture as a prefix
	 * (`llama.block_count`), so naming them here would mean hard-coding one architecture.
	 */
	private async inspectModel(tag: string): Promise<LocalModelDetails> {
		if (!tag) {
			return {};
		}
		const body = await this.getJson('/api/show', { model: tag }).catch(() => undefined);
		const modelInfo = (body as { model_info?: unknown })?.model_info;
		return modelInfo && typeof modelInfo === 'object'
			? { modelInfo: modelInfo as Record<string, unknown> }
			: {};
	}

	private probe(): Promise<ProbeResult> {
		return new Promise<ProbeResult>(resolve => {
			const socket = connect({ host: OLLAMA_HOST, port: OLLAMA_PORT });
			let settled = false;
			const finish = (result: ProbeResult) => {
				if (settled) { return; }
				settled = true;
				socket.destroy();
				resolve(result);
			};
			socket.setTimeout(PROBE_TIMEOUT_MS);
			socket.once('connect', () => {
				socket.destroy();
				this.fetchTags().then(modelCount => finish({ running: true, modelCount }), () => finish({ running: true, modelCount: 0 }));
			});
			socket.once('error', () => finish({ running: false, modelCount: 0 }));
			socket.once('timeout', () => finish({ running: false, modelCount: 0 }));
		});
	}

	private async fetchTags(): Promise<number> {
		const body = await this.getJson('/api/tags');
		return Array.isArray((body as { models?: unknown })?.models)
			? ((body as { models: unknown[] }).models).length
			: 0;
	}

	/**
	 * One HTTP helper for every Ollama endpoint we touch. `payload` turns the call into a POST —
	 * `/api/show` takes the model tag in the body, `/api/tags` takes nothing.
	 *
	 * Inspecting a model gets a longer timeout than the liveness probe: reading metadata can wait
	 * on a busy server, and a false «unknown» would be shown to the user as if it were a fact.
	 */
	private async getJson(path: string, payload?: Record<string, unknown>): Promise<unknown> {
		const { request: httpRequest } = await import('http');
		const encoded = payload ? Buffer.from(JSON.stringify(payload), 'utf8') : undefined;
		const timeout = payload ? REQUEST_TIMEOUT_MS : PROBE_TIMEOUT_MS;

		return new Promise<unknown>((resolve, reject) => {
			const req = httpRequest({
				host: OLLAMA_HOST,
				port: OLLAMA_PORT,
				path,
				method: encoded ? 'POST' : 'GET',
				timeout,
				headers: encoded
					? { 'content-type': 'application/json', 'content-length': encoded.byteLength }
					: undefined,
			}, res => {
				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}
				const chunks: Buffer[] = [];
				res.on('data', chunk => chunks.push(chunk as Buffer));
				res.on('end', () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
					} catch (err) {
						reject(err);
					}
				});
				res.on('error', reject);
			});
			req.on('error', reject);
			req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
			if (encoded) { req.write(encoded); }
			req.end();
		});
	}

	private log(line: string) {
		this._onLog.fire({ text: line });
	}

	private done(ok: boolean) {
		this._onDone.fire({ ok });
	}

	private install(params: InstallParams) {
		const p = platform();
		const isMac = p === 'darwin';
		const isWin = p === 'win32';
		const isLinux = !isMac && !isWin;

		if (isMac) {
			// Deterministic macOS flow
			const cmd = '/bin/bash';
			const script = [
				'set -e',
				'echo [VibeIDE] macOS install starting...',
				'if [ -d /Applications/Ollama.app ]; then echo [VibeIDE] Found /Applications/Ollama.app; open -a Ollama; else',
				' if [ -x /opt/homebrew/bin/brew ] || [ -x /usr/local/bin/brew ]; then',
				'   eval "$([ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew shellenv || /usr/local/bin/brew shellenv)";',
				' else',
				'   echo [VibeIDE] Bootstrapping Homebrew...; /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)";',
				'   eval "$([ -x /opt/homebrew/bin/brew ] && /opt/homebrew/bin/brew shellenv || /usr/local/bin/brew shellenv)";',
				' fi;',
				' echo [VibeIDE] Installing Ollama via Homebrew Cask...; brew install --cask ollama || true; open -a Ollama; fi',
				'sleep 2',
				'echo [VibeIDE] Health check...',
				'curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo [VibeIDE] Ollama running || echo [VibeIDE] Ollama not reachable yet'
			].join('\n');
			this.exec(cmd, ['-lc', script]);
			return;
		}

		if (isLinux) {
			const cmd = '/bin/bash';
			const script = [
				'set -e',
				'echo [VibeIDE] Linux install starting...',
				'curl -fsSL https://ollama.com/install.sh | sh',
				'(ollama serve >/dev/null 2>&1 &) || true',
				'sleep 2',
				'echo [VibeIDE] Health check...',
				'curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && echo [VibeIDE] Ollama running || echo [VibeIDE] Ollama not reachable yet'
			].join('\n');
			this.exec(cmd, ['-lc', script]);
			return;
		}

		// Windows
		const cmd = 'powershell.exe';
		const ps = [
			'$ErrorActionPreference = "Stop";',
			'Write-Host "[VibeIDE] Windows install starting...";',
			'if (Get-Command winget -ErrorAction SilentlyContinue) {',
			'  winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements',
			'} elseif (Get-Command choco -ErrorAction SilentlyContinue) {',
			'  choco install ollama -y',
			'} else {',
			'  Write-Error "No package manager found (winget/choco)."',
			'}',
			'Start-Process -FilePath ollama -ArgumentList serve -WindowStyle Hidden',
			'Start-Sleep -Seconds 2',
			'try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:11434/api/tags -TimeoutSec 5; if ($r.StatusCode -eq 200) { Write-Host "[VibeIDE] Ollama running" } } catch { Write-Host "[VibeIDE] Ollama not reachable yet" }'
		].join('\n');
		this.exec(cmd, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ps]);
	}

	private exec(command: string, args: string[]) {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		child.stdout.on('data', d => this.log(d.toString()));
		child.stderr.on('data', d => this.log(d.toString()));
		child.on('close', code => this.done(code === 0));
		child.on('error', err => { this.log(String(err)); this.done(false); });
	}
}


