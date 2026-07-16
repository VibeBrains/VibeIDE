/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — main-process side: model store (download, SHA256, unzip into userData)
 * and lifecycle of the STT utility process. Exposed to the renderer via
 * `voice/vibeVoiceChannel.ts` (raw channel — session events and download progress are
 * push streams). Inference itself never runs in this process — see
 * `node/voice/vibeVoiceWorkerMain.ts`.
 */

import { existsSync, promises as fsPromises, createWriteStream } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { cpus } from 'os';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { UtilityProcess } from '../../../../../platform/utilityProcess/electron-main/utilityProcess.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { VoiceDownloadProgress, VoiceModelsState, VoiceProfileId, VoiceSessionEvent, VoiceStartSessionOptions, VoiceWorkerRequest, VoiceWorkerResponse, VOICE_PROFILE_IDS } from '../../common/voice/vibeVoiceTypes.js';
import { resolveVoiceSessionModelPaths, voiceArchivesForProfile, voiceDownloadBytesForProfile, voiceRequiredFilesForProfile } from '../../common/voice/vibeVoiceModels.js';
import { clampVoiceEndpointSilenceMs, clampVoiceKeepAliveSec, resolveVoiceThreads, VOICE_ENDPOINT_SILENCE_KEY, VOICE_KEEP_ALIVE_KEY, VOICE_MODELS_PATH_KEY, VOICE_THREADS_KEY } from '../../common/voice/vibeVoiceConfiguration.js';

const WORKER_ENTRY_POINT = 'vs/workbench/contrib/vibeide/node/voice/vibeVoiceWorkerMain';
/** Watchdog: if the worker does not confirm a stop in time, declare the session dead. */
const STOP_TIMEOUT_MS = 3000;
/** Download progress push throttle (bytes) — keeps the IPC event stream sparse. */
const PROGRESS_EMIT_STEP_BYTES = 1024 * 1024;

export class VibeVoiceMainService extends Disposable {

	private readonly _onSessionEvent = this._register(new Emitter<VoiceSessionEvent>());
	readonly onSessionEvent: Event<VoiceSessionEvent> = this._onSessionEvent.event;

	private readonly _onDownloadProgress = this._register(new Emitter<VoiceDownloadProgress>());
	readonly onDownloadProgress: Event<VoiceDownloadProgress> = this._onDownloadProgress.event;

	private worker: UtilityProcess | undefined;
	private readonly activeSessions = new Set<string>();
	private readonly stopWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
	private idleShutdownTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly activeProfileDownloads = new Map<VoiceProfileId, Promise<void>>();

	constructor(
		private readonly logService: ILogService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly configurationService: IConfigurationService,
		private readonly lifecycleMainService: ILifecycleMainService,
	) {
		super();
	}

	override dispose(): void {
		this.killWorker();
		super.dispose();
	}

	// ── Models ───────────────────────────────────────────────────────────────

	private modelsRoot(): string {
		const configured = this.configurationService.getValue<string>(VOICE_MODELS_PATH_KEY);
		if (typeof configured === 'string' && configured.trim()) {
			return configured.trim();
		}
		return join(this.environmentMainService.userDataPath, 'stt', 'models');
	}

	private isProfileInstalled(profileId: VoiceProfileId): boolean {
		const root = this.modelsRoot();
		return voiceRequiredFilesForProfile(profileId).every(rel => existsSync(join(root, rel)));
	}

	getState(): VoiceModelsState {
		const profiles = {} as VoiceModelsState['profiles'] & Record<VoiceProfileId, { state: 'ready' | 'missing' | 'downloading'; downloadBytes: number }>;
		for (const profileId of VOICE_PROFILE_IDS) {
			const state = this.activeProfileDownloads.has(profileId)
				? 'downloading' as const
				: this.isProfileInstalled(profileId) ? 'ready' as const : 'missing' as const;
			profiles[profileId] = { state, downloadBytes: state === 'ready' ? 0 : voiceDownloadBytesForProfile(profileId) };
		}
		return { profiles };
	}

	/** Download, verify and unpack every missing archive of the profile (serialized per profile). */
	ensureModels(profileId: VoiceProfileId): Promise<void> {
		const running = this.activeProfileDownloads.get(profileId);
		if (running) {
			return running;
		}
		const task = this.doEnsureModels(profileId).finally(() => this.activeProfileDownloads.delete(profileId));
		this.activeProfileDownloads.set(profileId, task);
		return task;
	}

	private async doEnsureModels(profileId: VoiceProfileId): Promise<void> {
		const root = this.modelsRoot();
		const missing = voiceArchivesForProfile(profileId).filter(a => !a.files.every(f => existsSync(join(root, a.dir, f))));
		const totalBytes = missing.reduce((sum, a) => sum + a.sizeBytes, 0);
		let receivedBytes = 0;
		let lastEmitted = 0;
		const emitProgress = (done: boolean, error?: string) => {
			this._onDownloadProgress.fire({ profileId, receivedBytes, totalBytes, done, error });
		};
		try {
			await fsPromises.mkdir(root, { recursive: true });
			for (const archive of missing) {
				const zipPath = join(root, `.download-${archive.id}.zip`);
				this.logService.info(`[vibeVoice] downloading ${archive.id} (${archive.sizeBytes} bytes)`);
				try {
					await this.downloadWithSha256(archive.url, zipPath, archive.sha256, chunkBytes => {
						receivedBytes += chunkBytes;
						if (receivedBytes - lastEmitted >= PROGRESS_EMIT_STEP_BYTES) {
							lastEmitted = receivedBytes;
							emitProgress(false);
						}
					});
					const { extract } = await import('../../../../../base/node/zip.js');
					await extract(zipPath, root, {}, CancellationToken.None);
				} finally {
					await fsPromises.rm(zipPath, { force: true });
				}
				if (!archive.files.every(f => existsSync(join(root, archive.dir, f)))) {
					throw new Error(`Archive ${archive.id} did not contain the expected files`);
				}
			}
			receivedBytes = totalBytes;
			emitProgress(true);
			this.logService.info(`[vibeVoice] models for profile '${profileId}' ready`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[vibeVoice] model download failed: ${message}`);
			emitProgress(true, message);
			throw error;
		}
	}

	private async downloadWithSha256(url: string, filePath: string, expectedHex: string, onChunk: (bytes: number) => void): Promise<void> {
		const res = await this.followRedirectGet(url, 0);
		const hash = createHash('sha256');
		await new Promise<void>((resolve, reject) => {
			const out = createWriteStream(filePath);
			res.on('data', (c: Buffer | string) => {
				const buf = typeof c === 'string' ? Buffer.from(c) : c;
				hash.update(buf);
				onChunk(buf.byteLength);
				if (!out.write(buf)) {
					res.pause();
					out.once('drain', () => res.resume());
				}
			});
			res.on('end', () => out.end());
			res.on('error', reject);
			out.on('error', reject);
			out.on('finish', () => {
				const digest = hash.digest('hex');
				if (digest.toLowerCase() !== expectedHex.toLowerCase()) {
					reject(new Error('SHA256 mismatch'));
				} else {
					resolve();
				}
			});
		});
	}

	private async followRedirectGet(urlStr: string, depth: number): Promise<import('http').IncomingMessage> {
		if (depth > 10) {
			throw new Error('Too many redirects');
		}
		const https = await import('https');
		return new Promise((resolve, reject) => {
			https.get(urlStr, { headers: { 'User-Agent': 'VibeIDE-VoiceModels', 'Accept': '*/*' } }, res => {
				if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume();
					const next = new URL(res.headers.location, urlStr).href;
					this.followRedirectGet(next, depth + 1).then(resolve, reject);
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
					return;
				}
				resolve(res);
			}).on('error', reject);
		});
	}

	// ── Sessions / worker ────────────────────────────────────────────────────

	startSession(options: VoiceStartSessionOptions): void {
		if (!this.isProfileInstalled(options.profileId)) {
			throw new Error(`Voice models for profile '${options.profileId}' are not installed`);
		}
		if (this.idleShutdownTimer) {
			clearTimeout(this.idleShutdownTimer);
			this.idleShutdownTimer = undefined;
		}
		const request: VoiceWorkerRequest = {
			t: 'start',
			sessionId: options.sessionId,
			models: resolveVoiceSessionModelPaths(this.modelsRoot(), options.profileId),
			numThreads: resolveVoiceThreads(this.configurationService.getValue<number>(VOICE_THREADS_KEY) ?? 0, cpus().length),
			endpointSilenceMs: clampVoiceEndpointSilenceMs(this.configurationService.getValue<number>(VOICE_ENDPOINT_SILENCE_KEY)),
		};
		this.activeSessions.add(options.sessionId);
		const reused = !!this.worker;
		const posted = this.ensureWorker().postMessage(request);
		this.logService.info(`[vibeVoice] session ${options.sessionId} start (${options.profileId}, worker ${reused ? 'reused' : 'spawned'}, posted=${posted})`);
	}

	pushAudio(sessionId: string, pcm: Uint8Array): void {
		if (this.worker && this.activeSessions.has(sessionId)) {
			this.worker.postMessage({ t: 'audio', sessionId, pcm } satisfies VoiceWorkerRequest);
		}
	}

	stopSession(sessionId: string): void {
		this.endSession(sessionId, 'stop');
	}

	cancelSession(sessionId: string): void {
		this.endSession(sessionId, 'cancel');
	}

	private endSession(sessionId: string, t: 'stop' | 'cancel'): void {
		if (!this.worker || !this.activeSessions.has(sessionId)) {
			return;
		}
		this.worker.postMessage({ t, sessionId } satisfies VoiceWorkerRequest);
		// The flush happens inside a native decoder — if it never answers, unblock the
		// renderer and recycle the worker instead of leaving a stuck session behind.
		this.stopWatchdogs.set(sessionId, setTimeout(() => {
			this.logService.warn(`[vibeVoice] worker did not confirm ${t} of session ${sessionId} in ${STOP_TIMEOUT_MS}ms — recycling`);
			this.finishSession(sessionId);
			this._onSessionEvent.fire({ sessionId, type: 'stopped' });
			this.killWorker();
		}, STOP_TIMEOUT_MS));
	}

	private ensureWorker(): UtilityProcess {
		if (this.worker) {
			return this.worker;
		}
		const worker = new UtilityProcess(this.logService, NullTelemetryService, this.lifecycleMainService);
		worker.start({
			type: 'vibeVoiceStt',
			name: 'vibe-voice-stt',
			entryPoint: WORKER_ENTRY_POINT,
			correlationId: generateUuid(),
		});
		worker.onStdout(chunk => this.logService.trace(`[vibeVoice worker] ${chunk}`));
		worker.onStderr(chunk => this.logService.error(`[vibeVoice worker] ${chunk}`));
		worker.onMessage(msg => this.handleWorkerMessage(msg as VoiceWorkerResponse));
		const onGone = (reason: string) => (event: { code?: number } | undefined) => {
			this.logService.info(`[vibeVoice] worker gone (${reason}, code=${event?.code ?? '?'}, current=${this.worker === worker})`);
			if (this.worker !== worker) {
				return;
			}
			this.worker = undefined;
			for (const sessionId of [...this.activeSessions]) {
				this.finishSession(sessionId);
				this._onSessionEvent.fire({ sessionId, type: 'error', message: reason });
				this._onSessionEvent.fire({ sessionId, type: 'stopped' });
			}
		};
		worker.onExit(onGone('exit'));
		worker.onCrash(onGone('crash'));
		this.worker = worker;
		return worker;
	}

	private handleWorkerMessage(msg: VoiceWorkerResponse): void {
		if (msg.type !== 'partial' && msg.type !== 'final') {
			this.logService.info(`[vibeVoice] session ${msg.sessionId} ${msg.type}${msg.type === 'error' ? `: ${msg.message}` : ''}`);
		}
		if (msg.type === 'stopped') {
			this.finishSession(msg.sessionId);
		}
		this._onSessionEvent.fire(msg);
	}

	private finishSession(sessionId: string): void {
		this.activeSessions.delete(sessionId);
		const watchdog = this.stopWatchdogs.get(sessionId);
		if (watchdog) {
			clearTimeout(watchdog);
			this.stopWatchdogs.delete(sessionId);
		}
		if (this.activeSessions.size === 0) {
			this.scheduleIdleShutdown();
		}
	}

	/** Unload the worker (and its ~0.5 GB of models) after the configured idle period. */
	private scheduleIdleShutdown(): void {
		if (this.idleShutdownTimer) {
			clearTimeout(this.idleShutdownTimer);
		}
		const keepAliveSec = clampVoiceKeepAliveSec(this.configurationService.getValue<number>(VOICE_KEEP_ALIVE_KEY));
		if (keepAliveSec === 0) {
			this.killWorker();
			return;
		}
		this.idleShutdownTimer = setTimeout(() => {
			if (this.activeSessions.size === 0) {
				this.killWorker();
			}
		}, keepAliveSec * 1000);
	}

	private killWorker(): void {
		if (this.idleShutdownTimer) {
			clearTimeout(this.idleShutdownTimer);
			this.idleShutdownTimer = undefined;
		}
		for (const watchdog of this.stopWatchdogs.values()) {
			clearTimeout(watchdog);
		}
		this.stopWatchdogs.clear();
		this.activeSessions.clear();
		this.worker?.kill();
		this.worker = undefined;
	}
}
