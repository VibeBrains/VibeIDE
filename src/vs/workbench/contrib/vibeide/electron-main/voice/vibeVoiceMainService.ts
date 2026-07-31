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

import { existsSync, promises as fsPromises } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'path' in an electron-main service (by design)
import { join } from 'path';
import { cpus } from 'os';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { ILifecycleMainService } from '../../../../../platform/lifecycle/electron-main/lifecycleMainService.js';
import { UtilityProcess } from '../../../../../platform/utilityProcess/electron-main/utilityProcess.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { VoiceBatchDecodeResult, VoiceDownloadProgress, VoiceModelsState, VoiceProfileId, VoiceSessionEvent, VoiceStartSessionOptions, VoiceWorkerRequest, VoiceWorkerResponse, VOICE_PROFILE_IDS, VOICE_SAMPLE_RATE } from '../../common/voice/vibeVoiceTypes.js';
import { resolveVoiceBatchOfflinePaths, resolveVoiceSessionModelPaths, VoiceEnglishBatchTier, VoiceModelArchive, voiceArchivesForProfile, voiceBatchArchivesForProfile, voiceBatchDownloadBytesForProfile, voiceBatchRequiredFilesForProfile, voiceDownloadBytesForProfile, voiceRequiredFilesForProfile } from '../../common/voice/vibeVoiceModels.js';
import { clampVoiceEndpointSilenceMs, clampVoiceKeepAliveSec, resolveVoiceEnglishBatchTier, resolveVoiceThreads, VOICE_ENDPOINT_SILENCE_KEY, VOICE_ENGLISH_BATCH_MODEL_KEY, VOICE_KEEP_ALIVE_KEY, VOICE_MODELS_PATH_KEY, VOICE_THREADS_KEY } from '../../common/voice/vibeVoiceConfiguration.js';
import { downloadWithSha256 } from '../vibeVerifiedDownload.js';

const WORKER_ENTRY_POINT = 'vs/workbench/contrib/vibeide/node/voice/vibeVoiceWorkerMain';
/** Watchdog: if the worker does not confirm a stop in time, declare the session dead. */
const STOP_TIMEOUT_MS = 3000;
/** Watchdog for one batch-decode chunk (≤28 s of audio; CPU decode is a few seconds). */
const BATCH_DECODE_TIMEOUT_MS = 60_000;
/** Batch transcription slice — matches the worker's MAX_SEGMENT_SECONDS decoder cap. */
const BATCH_CHUNK_SECONDS = 28;
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
	/** Keyed by profileId (dictation bundle) or `${profileId}:batch` (offline /watch model). */
	private readonly activeProfileDownloads = new Map<string, Promise<void>>();
	private readonly activeBatchRequests = new Map<string, { resolve: (text: string) => void; reject: (error: Error) => void; watchdog: ReturnType<typeof setTimeout> }>();
	/** Whole transcription jobs (many chunks) — keeps idle shutdown away between chunks. */
	private readonly activeBatchJobs = new Set<string>();

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

	/** Configured English batch tier (`small`/`medium`); RU ignores it (GigaAM always). */
	private englishBatchTier(): VoiceEnglishBatchTier {
		return resolveVoiceEnglishBatchTier(this.configurationService.getValue<unknown>(VOICE_ENGLISH_BATCH_MODEL_KEY));
	}

	private isBatchInstalled(profileId: VoiceProfileId): boolean {
		const root = this.modelsRoot();
		return voiceBatchRequiredFilesForProfile(profileId, this.englishBatchTier()).every(rel => existsSync(join(root, rel)));
	}

	getState(): VoiceModelsState {
		// eslint-disable-next-line local/code-no-dangerous-type-assertions -- empty accumulator filled in the loop below
		const profiles = {} as VoiceModelsState['profiles'] & Record<VoiceProfileId, { state: 'ready' | 'missing' | 'downloading'; downloadBytes: number }>;
		for (const profileId of VOICE_PROFILE_IDS) {
			const state = this.activeProfileDownloads.has(profileId)
				? 'downloading' as const
				: this.isProfileInstalled(profileId) ? 'ready' as const : 'missing' as const;
			profiles[profileId] = { state, downloadBytes: state === 'ready' ? 0 : voiceDownloadBytesForProfile(profileId) };
		}
		return { profiles };
	}

	/** Batch model install state + bytes for one profile (the `/watch` transcription models). */
	getBatchState(profileId: VoiceProfileId): { state: 'ready' | 'missing' | 'downloading'; downloadBytes: number } {
		const tier = this.englishBatchTier();
		const state = this.activeProfileDownloads.has(`${profileId}:batch`)
			? 'downloading' as const
			: this.isBatchInstalled(profileId) ? 'ready' as const : 'missing' as const;
		return { state, downloadBytes: state === 'ready' ? 0 : voiceBatchDownloadBytesForProfile(profileId, tier) };
	}

	/** Download, verify and unpack every missing archive of the profile (serialized per profile). */
	ensureModels(profileId: VoiceProfileId): Promise<void> {
		return this.serializedDownload(profileId, voiceArchivesForProfile(profileId));
	}

	/** Download only the offline batch archives (`/watch`); dedup key distinct from dictation. */
	ensureBatchModel(profileId: VoiceProfileId): Promise<void> {
		return this.serializedDownload(`${profileId}:batch`, voiceBatchArchivesForProfile(profileId, this.englishBatchTier()), profileId);
	}

	private serializedDownload(key: string, archives: readonly VoiceModelArchive[], progressProfileId?: VoiceProfileId): Promise<void> {
		const running = this.activeProfileDownloads.get(key);
		if (running) {
			return running;
		}
		const task = this.doEnsureModels(progressProfileId ?? key as VoiceProfileId, archives).finally(() => this.activeProfileDownloads.delete(key));
		this.activeProfileDownloads.set(key, task);
		return task;
	}

	private async doEnsureModels(profileId: VoiceProfileId, archives: readonly VoiceModelArchive[]): Promise<void> {
		const root = this.modelsRoot();
		const missing = archives.filter(a => !a.files.every(f => existsSync(join(root, a.dir, f))));
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
					await downloadWithSha256(archive.url, zipPath, archive.sha256, chunkBytes => {
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

	// ── Batch transcription (video /watch transcript fallback) ───────────────

	/** True when the profile's offline batch model is installed (its `/watch` transcript input). */
	isBatchTranscriptionAvailable(profileId: VoiceProfileId): boolean {
		return this.isBatchInstalled(profileId);
	}

	/**
	 * Offline transcription of 16 kHz mono PCM16 audio of any length: sliced into ≤28 s
	 * chunks (the worker's segment cap) and decoded sequentially by the offline model.
	 * Only profiles with an offline model support this (RU/GigaAM). The whole job counts
	 * as one busy period for the idle-shutdown logic, so the engine stays loaded between
	 * chunks even with `keepAliveSec: 0`.
	 */
	async transcribePcm16(pcm: Uint8Array, profileId: VoiceProfileId, onProgress?: (processedSec: number, totalSec: number) => void, token?: CancellationToken): Promise<{ startSec: number; endSec: number; text: string }[]> {
		if (!this.isBatchInstalled(profileId)) {
			throw new Error(`Voice batch model for profile '${profileId}' is not installed`);
		}
		const offline = resolveVoiceBatchOfflinePaths(this.modelsRoot(), profileId, this.englishBatchTier());
		const numThreads = resolveVoiceThreads(this.configurationService.getValue<number>(VOICE_THREADS_KEY) ?? 0, cpus().length);
		const bytesPerSecond = VOICE_SAMPLE_RATE * 2;
		const chunkBytes = BATCH_CHUNK_SECONDS * bytesPerSecond;
		const totalSec = pcm.byteLength / bytesPerSecond;
		const jobId = generateUuid();
		this.activeBatchJobs.add(jobId);
		if (this.idleShutdownTimer) {
			clearTimeout(this.idleShutdownTimer);
			this.idleShutdownTimer = undefined;
		}
		try {
			const segments: { startSec: number; endSec: number; text: string }[] = [];
			for (let offset = 0; offset < pcm.byteLength; offset += chunkBytes) {
				if (token?.isCancellationRequested) {
					throw new CancellationError();
				}
				// Even byte offsets only — an odd slice start would shear every PCM16 sample.
				const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.byteLength));
				const startSec = offset / bytesPerSecond;
				const endSec = Math.min(totalSec, startSec + BATCH_CHUNK_SECONDS);
				const text = await this.decodeBatchChunk(chunk, offline, numThreads);
				if (text) {
					segments.push({ startSec, endSec, text });
				}
				onProgress?.(endSec, totalSec);
			}
			return segments;
		} finally {
			this.activeBatchJobs.delete(jobId);
			if (this.activeSessions.size === 0 && this.activeBatchJobs.size === 0) {
				this.scheduleIdleShutdown();
			}
		}
	}

	private decodeBatchChunk(pcm: Uint8Array, offline: NonNullable<ReturnType<typeof resolveVoiceSessionModelPaths>['offline']>, numThreads: number): Promise<string> {
		const requestId = generateUuid();
		const request: VoiceWorkerRequest = { t: 'decodeBatch', requestId, offline, numThreads, pcm };
		return new Promise<string>((resolve, reject) => {
			const watchdog = setTimeout(() => {
				this.logService.warn(`[vibeVoice] batch decode ${requestId} did not answer in ${BATCH_DECODE_TIMEOUT_MS}ms — recycling worker`);
				this.activeBatchRequests.delete(requestId);
				reject(new Error('Batch decode timed out'));
				this.killWorker();
			}, BATCH_DECODE_TIMEOUT_MS);
			this.activeBatchRequests.set(requestId, { resolve, reject, watchdog });
			this.ensureWorker().postMessage(request);
		});
	}

	private handleBatchResult(msg: VoiceBatchDecodeResult): void {
		const pending = this.activeBatchRequests.get(msg.requestId);
		if (!pending) {
			return;
		}
		clearTimeout(pending.watchdog);
		this.activeBatchRequests.delete(msg.requestId);
		if (msg.error !== undefined) {
			pending.reject(new Error(msg.error));
		} else {
			pending.resolve(msg.text ?? '');
		}
	}

	private rejectAllBatches(reason: string): void {
		for (const [requestId, pending] of [...this.activeBatchRequests]) {
			clearTimeout(pending.watchdog);
			this.activeBatchRequests.delete(requestId);
			pending.reject(new Error(reason));
		}
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
			this.rejectAllBatches(`STT worker ${reason}`);
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
		if (msg.type === 'batchResult') {
			this.handleBatchResult(msg);
			return;
		}
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
			if (this.activeSessions.size === 0 && this.activeBatchJobs.size === 0) {
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
		this.rejectAllBatches('STT worker recycled');
		this.worker?.kill();
		this.worker = undefined;
	}
}
