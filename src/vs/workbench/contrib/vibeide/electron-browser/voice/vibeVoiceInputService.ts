/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Voice input — desktop renderer implementation (contract in `common/voice/
 * vibeVoiceInputService.ts`). Three responsibilities in one service, all sharing the
 * `vibeide-channel-voice` main-process channel:
 *
 * 1. `ISpeechProvider` registered into the upstream `ISpeechService` — this alone brings
 *    editor dictation (Cmd/Ctrl+Alt+V, ghost preview, hold mode), terminal dictation and
 *    the dynamic `accessibility.voice.*` settings to life.
 * 2. Mic capture: `getUserMedia` → 16 kHz `AudioContext` → PCM16 chunks over the channel.
 *    Capture is only possible in the workbench renderer ('media' permission is granted to
 *    core windows by `app.ts#configureSession`).
 * 3. The chat facade (`IVibeVoiceInputService`) consumed by the React mic button — its
 *    sessions still go through `ISpeechService` so context keys and the start/stop
 *    accessibility sounds behave exactly like editor dictation.
 *
 * Contract invariants (see docs/knowledge/voice/): provider sessions are created
 * synchronously; `Started` fires only when the mic AND the engine are live; every error
 * path ends with `Stopped` (a missing `Stopped` permanently wedges the upstream
 * `speechToTextInProgress` context key); token cancellation is a HARD cancel because
 * upstream consumers ignore events after cancellation — the graceful flush-the-tail stop
 * exists only on the chat facade, which owns its session lifecycle.
 */

import { localize } from '../../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { isMacintosh, isWindows } from '../../../../../base/common/platform.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ISpeechProvider, ISpeechService, ISpeechToTextEvent, ISpeechToTextSession, ITextToSpeechEvent, IKeywordRecognitionEvent, KeywordRecognitionStatus, SpeechToTextStatus, TextToSpeechStatus, SPEECH_LANGUAGE_CONFIG } from '../../../speech/common/speechService.js';
import { IVibeModalService } from '../../common/vibeModalService.js';
import { IVibeVoiceInputService, IVibeVoiceInputState, IVibeVoiceTextEvent, VoiceInputModelState } from '../../common/voice/vibeVoiceInputService.js';
import { VIBE_VOICE_CHANNEL, VOICE_SAMPLE_RATE, VoiceDownloadProgress, VoiceModelsState, VoiceProfileId, VoiceSessionEvent } from '../../common/voice/vibeVoiceTypes.js';
import { resolveVoiceProfile, voiceDownloadBytesForProfile } from '../../common/voice/vibeVoiceModels.js';
import { VOICE_ENABLED_KEY } from '../../common/voice/vibeVoiceConfiguration.js';

const PROVIDER_ID = 'vibeide.voice';
/** ScriptProcessor frame: 2048 samples @ 16 kHz ≈ 128 ms per chunk — fine for streaming. */
const CAPTURE_FRAME_SAMPLES = 2048;
/** Mic-level meter gain (RMS → 0..1), tuned for speech (borrowed from VoxLocal). */
const LEVEL_RMS_GAIN = 18;
/** Chunks buffered while the engine warms up (~13 s) before we start dropping the oldest. */
const MAX_QUEUED_CHUNKS = 100;

function bytesToMegabytes(bytes: number): number {
	return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

// ── Channel client ───────────────────────────────────────────────────────────

class VoiceChannelClient {

	// Long-lived local emitters over a SINGLE permanent remote subscription. Subscribing to
	// `channel.listen(...)` per session and disposing between sessions silently kills the
	// event stream: ChannelClient#requestEvent deletes its response handler on the last
	// unsubscribe and never re-registers it on a re-subscribe (upstream consumers only ever
	// subscribe once, so the trap is invisible there) — the second dictation session would
	// never see its 'ready'.
	private readonly _onSessionEvent = new Emitter<VoiceSessionEvent>();
	readonly onSessionEvent: Event<VoiceSessionEvent> = this._onSessionEvent.event;

	private readonly _onDownloadProgress = new Emitter<VoiceDownloadProgress>();
	readonly onDownloadProgress: Event<VoiceDownloadProgress> = this._onDownloadProgress.event;

	constructor(private readonly mainProcessService: IMainProcessService) {
		const channel = this.channel();
		channel.listen<VoiceSessionEvent>('onSessionEvent')(e => this._onSessionEvent.fire(e));
		channel.listen<VoiceDownloadProgress>('onDownloadProgress')(e => this._onDownloadProgress.fire(e));
	}

	private channel() {
		return this.mainProcessService.getChannel(VIBE_VOICE_CHANNEL);
	}

	getState(): Promise<VoiceModelsState> {
		return this.channel().call('getState');
	}

	ensureModels(profileId: VoiceProfileId): Promise<void> {
		return this.channel().call('ensureModels', profileId);
	}

	getBatchState(profileId: VoiceProfileId): Promise<{ state: 'ready' | 'missing' | 'downloading'; downloadBytes: number }> {
		return this.channel().call('getBatchState', profileId);
	}

	ensureBatchModel(profileId: VoiceProfileId): Promise<void> {
		return this.channel().call('ensureBatchModel', profileId);
	}

	startSession(sessionId: string, profileId: VoiceProfileId): Promise<void> {
		return this.channel().call('startSession', { sessionId, profileId });
	}

	pushAudio(sessionId: string, pcm: VSBuffer): void {
		// Tuple, not object: the IPC serializer walks arrays element-wise but JSON-stringifies
		// plain objects — a VSBuffer nested in an object arrives as a mangled plain object.
		this.channel().call('pushAudio', [sessionId, pcm]);
	}

	stopSession(sessionId: string): void {
		this.channel().call('stopSession', sessionId);
	}

	cancelSession(sessionId: string): void {
		this.channel().call('cancelSession', sessionId);
	}
}

// ── Capture session (one dictation) ──────────────────────────────────────────

interface IVoiceSessionHost {
	readonly channel: VoiceChannelClient;
	readonly logService: ILogService;
	resolveProfileId(sessionLanguage: string | undefined): VoiceProfileId;
	fetchModelsState(): Promise<VoiceModelsState>;
	promptMissingModels(profileId: VoiceProfileId): void;
	notifyMicrophoneError(error: unknown): void;
	reportLevel(level: number): void;
}

class VoiceCaptureSession extends Disposable implements ISpeechToTextSession {

	private readonly _onDidChange = this._register(new Emitter<ISpeechToTextEvent>());
	readonly onDidChange = this._onDidChange.event;

	private readonly sessionId = generateUuid();
	private readonly profileId: VoiceProfileId;

	private ended = false;
	private startedFired = false;
	private engineReady = false;
	private engineStarted = false;
	private capturing = false;
	private queueDropWarned = false;
	private readonly queuedChunks: VSBuffer[] = [];

	private mediaStream: MediaStream | undefined;
	private audioContext: AudioContext | undefined;

	constructor(
		private readonly host: IVoiceSessionHost,
		token: CancellationToken,
		language: string | undefined,
	) {
		super();
		this.profileId = host.resolveProfileId(language);
		this._register(this.host.channel.onSessionEvent(e => this.handleSessionEvent(e)));
		this._register(token.onCancellationRequested(() => this.cancel()));
		this.initialize().catch(error => this.fail(error instanceof Error ? error.message : String(error)));
	}

	private async initialize(): Promise<void> {
		const state = await this.host.fetchModelsState();
		if (this.ended) {
			return;
		}
		if (state.profiles[this.profileId].state !== 'ready') {
			this.host.promptMissingModels(this.profileId);
			this.fail(localize('vibeVoice.modelsMissing', "Модели голосового ввода не скачаны"));
			return;
		}
		// Engine warm-up (model load) and mic acquisition run in parallel; audio is queued
		// until the worker confirms the session, so the first phonemes are not lost.
		this.engineStarted = true;
		this.host.channel.startSession(this.sessionId, this.profileId).catch(error => this.fail(String(error)));
		try {
			await this.startCapture();
		} catch (error) {
			this.host.notifyMicrophoneError(error);
			this.fail(localize('vibeVoice.micUnavailable', "Микрофон недоступен"));
		}
	}

	private async startCapture(): Promise<void> {
		this.mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		if (this.ended) {
			this.teardownCapture();
			return;
		}
		// A 16 kHz context makes Chromium resample the mic input for us — the engine
		// consumes the frames as-is, no manual resampler involved.
		this.audioContext = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE });
		const source = this.audioContext.createMediaStreamSource(this.mediaStream);
		const processor = this.audioContext.createScriptProcessor(CAPTURE_FRAME_SAMPLES, 1, 1);
		processor.onaudioprocess = event => this.handleAudioFrame(event.inputBuffer.getChannelData(0));
		source.connect(processor);
		processor.connect(this.audioContext.destination); // required for onaudioprocess; output stays silent
		this.capturing = true;
		this.maybeFireStarted();
	}

	private handleAudioFrame(samples: Float32Array): void {
		if (this.ended || !this.capturing) {
			return;
		}
		let sumSquares = 0;
		const pcm = new Int16Array(samples.length);
		for (let i = 0; i < samples.length; i++) {
			const sample = Math.max(-1, Math.min(1, samples[i]));
			sumSquares += sample * sample;
			pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		}
		this.host.reportLevel(Math.min(1, Math.sqrt(sumSquares / samples.length) * LEVEL_RMS_GAIN));
		const chunk = VSBuffer.wrap(new Uint8Array(pcm.buffer));
		if (this.engineReady) {
			this.host.channel.pushAudio(this.sessionId, chunk);
		} else {
			if (this.queuedChunks.length >= MAX_QUEUED_CHUNKS) {
				this.queuedChunks.shift();
				if (!this.queueDropWarned) {
					this.queueDropWarned = true;
					this.host.logService.warn('[vibeVoice] engine warm-up is slow — dropping oldest queued audio');
				}
			}
			this.queuedChunks.push(chunk);
		}
	}

	private handleSessionEvent(e: VoiceSessionEvent): void {
		if (e.sessionId !== this.sessionId || this.ended) {
			return;
		}
		switch (e.type) {
			case 'ready':
				this.engineReady = true;
				for (const chunk of this.queuedChunks.splice(0)) {
					this.host.channel.pushAudio(this.sessionId, chunk);
				}
				this.maybeFireStarted();
				break;
			case 'partial':
				this._onDidChange.fire({ status: SpeechToTextStatus.Recognizing, text: e.text });
				break;
			case 'final':
				this._onDidChange.fire({ status: SpeechToTextStatus.Recognized, text: e.text });
				break;
			case 'error':
				this._onDidChange.fire({ status: SpeechToTextStatus.Error, text: e.message });
				break;
			case 'stopped':
				this.end();
				break;
		}
	}

	private maybeFireStarted(): void {
		if (!this.startedFired && this.engineReady && this.capturing && !this.ended) {
			this.startedFired = true;
			this._onDidChange.fire({ status: SpeechToTextStatus.Started });
		}
	}

	/** Chat-facade stop: close the mic now, let the worker flush the tail into a last final. */
	gracefulStop(): void {
		if (this.ended) {
			return;
		}
		this.teardownCapture();
		if (this.engineStarted) {
			this.host.channel.stopSession(this.sessionId); // 'stopped' arrives after the flush
		} else {
			this.end();
		}
	}

	/** Hard cancel (token cancellation / Esc): discard pending audio, end fast. */
	cancel(): void {
		if (this.ended) {
			return;
		}
		this.teardownCapture();
		if (this.engineStarted) {
			this.host.channel.cancelSession(this.sessionId);
		}
		this.end();
	}

	private fail(message: string): void {
		if (this.ended) {
			return;
		}
		this._onDidChange.fire({ status: SpeechToTextStatus.Error, text: message });
		if (this.engineStarted && this.engineReady) {
			this.host.channel.cancelSession(this.sessionId);
		}
		this.end();
	}

	private end(): void {
		if (this.ended) {
			return;
		}
		this.ended = true;
		this.teardownCapture();
		this._onDidChange.fire({ status: SpeechToTextStatus.Stopped });
		this.dispose();
	}

	private teardownCapture(): void {
		this.capturing = false;
		this.queuedChunks.length = 0;
		this.mediaStream?.getTracks().forEach(track => track.stop());
		this.mediaStream = undefined;
		const context = this.audioContext;
		this.audioContext = undefined;
		context?.close().catch(() => { /* already closed */ });
	}
}

// ── Service ──────────────────────────────────────────────────────────────────

class VibeVoiceInputService extends Disposable implements IVibeVoiceInputService, IVoiceSessionHost {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVibeVoiceInputState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onText = this._register(new Emitter<IVibeVoiceTextEvent>());
	readonly onText = this._onText.event;

	private readonly _onLevel = this._register(new Emitter<number>());
	readonly onLevel = this._onLevel.event;

	readonly channel: VoiceChannelClient;

	private readonly providerRegistration = this._register(new MutableDisposable());
	private modelsState: VoiceModelsState | undefined;
	private downloadPercent = 0;
	private confirmDialogOpen = false;
	private recording = false;
	private chatSession: VoiceCaptureSession | undefined;
	private chatCts: CancellationTokenSource | undefined;
	private startingChat = false;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@ISpeechService private readonly speechService: ISpeechService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IVibeModalService private readonly vibeModalService: IVibeModalService,
		@IProgressService private readonly progressService: IProgressService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ILogService readonly logService: ILogService,
	) {
		super();
		this.channel = new VoiceChannelClient(mainProcessService);
		this._register(this.channel.onDownloadProgress(e => this.handleDownloadProgress(e)));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VOICE_ENABLED_KEY)) {
				this.updateProviderRegistration();
				this.fireStateChange();
			}
		}));
		this.updateProviderRegistration();
		this.fetchModelsState().then(() => this.fireStateChange(), () => { /* main channel unavailable */ });
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(VOICE_ENABLED_KEY) !== false;
	}

	private updateProviderRegistration(): void {
		if (!this.isEnabled()) {
			this.providerRegistration.clear();
			return;
		}
		if (this.providerRegistration.value) {
			return;
		}
		const provider: ISpeechProvider = {
			metadata: {
				extension: new ExtensionIdentifier(PROVIDER_ID),
				displayName: localize('vibeVoice.providerName', "VibeIDE — локальное распознавание речи"),
			},
			createSpeechToTextSession: (token, options) => new VoiceCaptureSession(this, token, options?.language),
			createTextToSpeechSession: () => this.createStubTextToSpeechSession(),
			createKeywordRecognitionSession: () => this.createStubKeywordSession(),
		};
		this.providerRegistration.value = this.speechService.registerSpeechProvider(PROVIDER_ID, provider);
	}

	/** TTS is not implemented — a session that stops immediately keeps upstream consumers sane. */
	private createStubTextToSpeechSession() {
		const emitter = new Emitter<ITextToSpeechEvent>();
		queueMicrotask(() => emitter.fire({ status: TextToSpeechStatus.Stopped }));
		return { onDidChange: emitter.event, synthesize: async () => { } };
	}

	private createStubKeywordSession() {
		const emitter = new Emitter<IKeywordRecognitionEvent>();
		queueMicrotask(() => emitter.fire({ status: KeywordRecognitionStatus.Stopped }));
		return { onDidChange: emitter.event };
	}

	// ── IVoiceSessionHost ────────────────────────────────────────────────────

	resolveProfileId(sessionLanguage: string | undefined): VoiceProfileId {
		return resolveVoiceProfile(this.configurationService.getValue<unknown>(SPEECH_LANGUAGE_CONFIG), sessionLanguage);
	}

	async fetchModelsState(): Promise<VoiceModelsState> {
		this.modelsState = await this.channel.getState();
		return this.modelsState;
	}

	promptMissingModels(profileId: VoiceProfileId): void {
		this.runModelDownload(profileId);
	}

	notifyMicrophoneError(error: unknown): void {
		const name = error instanceof DOMException ? error.name : '';
		if (name === 'NotAllowedError' || name === 'SecurityError') {
			const settingsUri = isMacintosh
				? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
				: isWindows ? 'ms-settings:privacy-microphone' : undefined;
			this.notificationService.prompt(
				Severity.Warning,
				localize('vibeVoice.micDenied', "Доступ к микрофону запрещён. Разрешите VibeIDE использовать микрофон в настройках системы и повторите."),
				settingsUri ? [{ label: localize('vibeVoice.openSettings', "Открыть настройки"), run: () => this.openerService.open(URI.parse(settingsUri), { openExternal: true }) }] : [],
			);
		} else if (name === 'NotFoundError') {
			this.notificationService.warn(localize('vibeVoice.micNotFound', "Микрофон не найден. Подключите устройство ввода звука и повторите."));
		} else {
			this.notificationService.error(localize('vibeVoice.micError', "Не удалось начать запись с микрофона: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	reportLevel(level: number): void {
		this._onLevel.fire(level);
	}

	// ── Model download ───────────────────────────────────────────────────────

	private currentProfileId(): VoiceProfileId {
		return this.resolveProfileId(undefined);
	}

	private handleDownloadProgress(e: VoiceDownloadProgress): void {
		this.downloadPercent = e.totalBytes > 0 ? Math.min(100, Math.round(e.receivedBytes / e.totalBytes * 100)) : 0;
		if (e.done) {
			this.downloadPercent = 0;
			this.fetchModelsState().then(() => this.fireStateChange(), () => this.fireStateChange());
		} else {
			this.fireStateChange();
		}
	}

	/**
	 * Single consent gate for every download entry point (chat mic button, editor and
	 * terminal dictation): a themed VibeIDE modal stating the exact size, with
	 * Скачать/Отмена. Nothing is fetched without an explicit yes.
	 *
	 * Uses IVibeModalService (in-workbench React modal), not IDialogService — the latter
	 * resolves to a native Electron message box on desktop, which is off-DOM (untestable)
	 * and stylistically foreign to the rest of VibeIDE's confirmations.
	 */
	private async confirmModelDownload(profileId: VoiceProfileId): Promise<boolean> {
		if (this.confirmDialogOpen) {
			return false;
		}
		this.confirmDialogOpen = true;
		try {
			const megabytes = bytesToMegabytes(voiceDownloadBytesForProfile(profileId));
			const languageName = profileId === 'ru'
				? localize('vibeVoice.lang.ru', "русского языка")
				: localize('vibeVoice.lang.en', "английского языка");
			return await this.vibeModalService.confirmModal({
				title: localize('vibeVoice.confirmDownload', "Скачать модели голосового ввода?"),
				body: localize('vibeVoice.confirmDownloadDetail', "Будет загружено ~{0} МБ (однократно) — модели распознавания речи для {1}. Распознавание работает полностью локально, звук никуда не отправляется; модели сохранятся в данных пользователя.", megabytes, languageName),
				icon: 'mic',
				okLabel: localize('vibeVoice.confirmDownloadYes', "Скачать"),
				cancelLabel: localize('vibeVoice.confirmDownloadNo', "Отмена"),
			});
		} finally {
			this.confirmDialogOpen = false;
		}
	}

	private async runModelDownload(profileId: VoiceProfileId): Promise<void> {
		if (this.modelsState?.profiles[profileId].state === 'downloading') {
			return;
		}
		if (!await this.confirmModelDownload(profileId)) {
			return;
		}
		const megabytes = bytesToMegabytes(voiceDownloadBytesForProfile(profileId));
		// Optimistic 'downloading' so the button flips immediately, before the first progress event.
		this.markDownloading(profileId);
		this.fireStateChange();
		try {
			await this.progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('vibeVoice.downloadingTitle', "Загрузка моделей голосового ввода ({0} МБ)…", megabytes),
				},
				async progress => {
					let lastPercent = 0;
					const subscription = this.channel.onDownloadProgress(e => {
						if (e.profileId !== profileId || e.done || e.totalBytes === 0) {
							return;
						}
						const percent = Math.min(100, Math.round(e.receivedBytes / e.totalBytes * 100));
						progress.report({ increment: percent - lastPercent, message: `${percent}%` });
						lastPercent = percent;
					});
					try {
						await this.channel.ensureModels(profileId);
					} finally {
						subscription.dispose();
					}
				},
			);
			this.notificationService.info(localize('vibeVoice.downloadDone', "Модели голосового ввода готовы — запустите диктовку ещё раз."));
		} catch (error) {
			this.notificationService.prompt(
				Severity.Error,
				localize('vibeVoice.downloadFailed', "Не удалось скачать модели голосового ввода: {0}", error instanceof Error ? error.message : String(error)),
				[{ label: localize('vibeVoice.retryDownload', "Повторить"), run: () => this.runModelDownload(profileId) }],
			);
		} finally {
			await this.fetchModelsState().catch(() => undefined);
			this.fireStateChange();
		}
	}

	/** Local optimistic mirror of the main-side 'downloading' state. */
	private markDownloading(profileId: VoiceProfileId): void {
		if (this.modelsState) {
			this.modelsState = {
				profiles: { ...this.modelsState.profiles, [profileId]: { ...this.modelsState.profiles[profileId], state: 'downloading' } },
			};
		}
	}

	// ── IVibeVoiceInputService (chat facade) ─────────────────────────────────

	getState(): IVibeVoiceInputState {
		const profileId = this.currentProfileId();
		const profile = this.modelsState?.profiles[profileId];
		const modelState: VoiceInputModelState = profile?.state ?? 'missing';
		return {
			available: this.isEnabled(),
			recording: this.recording,
			modelState,
			downloadBytes: profile?.downloadBytes ?? voiceDownloadBytesForProfile(profileId),
			downloadPercent: this.downloadPercent,
		};
	}

	getActiveProfileId(): VoiceProfileId {
		return this.currentProfileId();
	}

	async ensureModelsReady(): Promise<boolean> {
		const profileId = this.currentProfileId();
		const state = await this.fetchModelsState();
		const current = state.profiles[profileId].state;
		if (current === 'ready') {
			return true;
		}
		if (current === 'downloading') {
			// Another entry point already got consent and started the download — join it
			// (main-side ensureModels dedupes per profile) instead of stacking a second dialog.
			try {
				await this.channel.ensureModels(profileId);
			} catch {
				// fall through to the state re-check
			}
		} else {
			await this.runModelDownload(profileId);
		}
		const after = await this.fetchModelsState().catch(() => undefined);
		this.fireStateChange();
		return after?.profiles[profileId].state === 'ready';
	}

	async ensureBatchModelReady(profileId: VoiceProfileId): Promise<boolean> {
		let state = await this.channel.getBatchState(profileId).catch(() => undefined);
		if (state?.state === 'ready') {
			return true;
		}
		if (state?.state !== 'downloading') {
			if (this.confirmDialogOpen) {
				return false;
			}
			this.confirmDialogOpen = true;
			let consented: boolean;
			try {
				consented = await this.vibeModalService.confirmModal({
					title: localize('vibeVoice.confirmBatchDownload', "Скачать модель для распознавания аудио?"),
					body: localize('vibeVoice.confirmBatchDownloadDetail', "Для разбора этого аудио командой /watch нужна локальная модель распознавания речи (~{0} МБ, однократно). Звук обрабатывается на этом компьютере и никуда не отправляется.", bytesToMegabytes(state?.downloadBytes ?? 0)),
					icon: 'mic',
					okLabel: localize('vibeVoice.confirmDownloadYes', "Скачать"),
					cancelLabel: localize('vibeVoice.confirmDownloadNo', "Отмена"),
				});
			} finally {
				this.confirmDialogOpen = false;
			}
			if (!consented) {
				return false;
			}
		}
		try {
			await this.progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('vibeVoice.downloadingBatchTitle', "Загрузка модели распознавания аудио ({0} МБ)…", bytesToMegabytes(state?.downloadBytes ?? 0)),
				},
				async progress => {
					let lastPercent = 0;
					const subscription = this.channel.onDownloadProgress(e => {
						if (e.profileId !== profileId || e.done || e.totalBytes === 0) {
							return;
						}
						const percent = Math.min(100, Math.round(e.receivedBytes / e.totalBytes * 100));
						progress.report({ increment: percent - lastPercent, message: `${percent}%` });
						lastPercent = percent;
					});
					try {
						await this.channel.ensureBatchModel(profileId);
					} finally {
						subscription.dispose();
					}
				},
			);
		} catch (error) {
			this.notificationService.error(localize('vibeVoice.batchDownloadFailed', "Не удалось скачать модель распознавания аудио: {0}", error instanceof Error ? error.message : String(error)));
			return false;
		}
		state = await this.channel.getBatchState(profileId).catch(() => undefined);
		return state?.state === 'ready';
	}

	private fireStateChange(): void {
		this._onDidChangeState.fire(this.getState());
	}

	async start(): Promise<void> {
		if (this.recording || this.startingChat || !this.isEnabled()) {
			return;
		}
		this.startingChat = true;
		try {
			const profileId = this.currentProfileId();
			const state = await this.fetchModelsState();
			if (state.profiles[profileId].state === 'downloading') {
				return;
			}
			if (state.profiles[profileId].state === 'missing') {
				await this.runModelDownload(profileId);
				return;
			}
			const cts = new CancellationTokenSource();
			this.chatCts = cts;
			// Through ISpeechService on purpose: same context keys and start/stop sounds
			// as editor dictation. The provider is ours, so the session created inside is
			// a VoiceCaptureSession — grab it to drive graceful stop.
			const session = await this.speechService.createSpeechToTextSession(cts.token, 'vibeChat');
			this.chatSession = session as VoiceCaptureSession;
			const listener = session.onDidChange(e => {
				switch (e.status) {
					case SpeechToTextStatus.Started:
						this.recording = true;
						this.fireStateChange();
						break;
					case SpeechToTextStatus.Recognizing:
						if (e.text) {
							this._onText.fire({ kind: 'interim', text: e.text });
						}
						break;
					case SpeechToTextStatus.Recognized:
						if (e.text) {
							this._onText.fire({ kind: 'final', text: e.text });
						}
						break;
					case SpeechToTextStatus.Stopped:
						listener.dispose();
						this.chatSession = undefined;
						this.chatCts?.dispose();
						this.chatCts = undefined;
						this.recording = false;
						this._onLevel.fire(0);
						this.fireStateChange();
						break;
				}
			});
		} finally {
			this.startingChat = false;
		}
	}

	stop(): void {
		this.chatSession?.gracefulStop();
	}

	cancel(): void {
		this.chatSession?.cancel();
	}
}

registerSingleton(IVibeVoiceInputService, VibeVoiceInputService, InstantiationType.Delayed);

/**
 * The speech provider must exist before anyone presses a dictation keybinding, and a
 * `Delayed` singleton only materializes on first injection — this contribution forces
 * that injection once the workbench has restored.
 */
class VibeVoiceInputContribution {
	static readonly ID = 'workbench.contrib.vibeVoiceInput';
	constructor(@IVibeVoiceInputService _service: IVibeVoiceInputService) { }
}

registerWorkbenchContribution2(VibeVoiceInputContribution.ID, VibeVoiceInputContribution, WorkbenchPhase.AfterRestored);
