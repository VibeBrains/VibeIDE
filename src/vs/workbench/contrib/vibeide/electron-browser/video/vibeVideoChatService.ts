/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — desktop renderer implementation (contract in
 * `common/video/vibeVideoChatService.ts`). Orchestrates the whole cycle for the chat:
 *
 * 1. Vision gate BEFORE any work: a non-vision chat model refuses immediately instead of
 *    after minutes of downloading (chatThreadService hard-blocks images anyway — this is
 *    the early, polite version of the same `isModelVisionCapable` decision). Inputs the
 *    extension hints as audio-only skip the gate: their request carries no images, so a
 *    non-vision model is fine.
 * 2. Tools consent + download (yt-dlp/ffmpeg from the `video-tools-v1` mirror) — the exact
 *    scheme of the STT models, sizes stated in a VibeIDE modal, nothing fetched silently.
 * 3. Main-process pipeline over `vibeide-channel-video` with a cancellable progress
 *    notification (stage labels + percent pushed from main).
 * 4. No subtitles → optional STT fallback through the voice facade (its own models consent).
 * 5. Frames (JPEG paths) → `ChatImageAttachment[]` via IFileService; transcript + frame
 *    timecode map composed into one vision request sent with
 *    `IChatThreadService.addUserMessageAndStreamResponse({ images, displayContent })`.
 */

import { localize } from '../../../../../nls.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IVibeModalService } from '../../common/vibeModalService.js';
import { IVibeVideoChatService, IVibeVideoChatState } from '../../common/video/vibeVideoChatService.js';
import { VIBE_VIDEO_CHANNEL, VideoAnalysisProgress, VideoAnalysisResult, VideoAnalysisStage, VideoAnalyzeOptions, VideoToolsDownloadProgress, VideoToolsState, VideoTranscriptSegment, formatVideoTimecode } from '../../common/video/vibeVideoTypes.js';
import { classifyWatchInput } from '../../common/video/vibeVideoTools.js';
import { VIDEO_ENABLED_KEY } from '../../common/video/vibeVideoConfiguration.js';
import { IVibeVoiceInputService } from '../../common/voice/vibeVoiceInputService.js';
import { VoiceProfileId } from '../../common/voice/vibeVoiceTypes.js';
import { IVibeideSettingsService } from '../../common/vibeideSettingsService.js';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { isModelVisionCapable } from '../../common/modelVisionHeuristics.js';
import { ChatImageAttachment } from '../../common/chatThreadServiceTypes.js';
import { IChatThreadService } from '../../browser/chatThreadService.js';

/** Transcript cap inside the prompt — a full hour of SRT would drown the frames' budget. */
const MAX_PROMPT_TRANSCRIPT_CHARS = 60_000;

function bytesToMegabytes(bytes: number): number {
	return Math.max(1, Math.round(bytes / (1024 * 1024)));
}

// ── Channel client ───────────────────────────────────────────────────────────

class VideoChannelClient {

	// Long-lived local emitters over a SINGLE permanent remote subscription — the
	// ChannelClient#requestEvent re-subscribe trap, see VoiceChannelClient for the story.
	private readonly _onToolsDownloadProgress = new Emitter<VideoToolsDownloadProgress>();
	readonly onToolsDownloadProgress: Event<VideoToolsDownloadProgress> = this._onToolsDownloadProgress.event;

	private readonly _onAnalysisProgress = new Emitter<VideoAnalysisProgress>();
	readonly onAnalysisProgress: Event<VideoAnalysisProgress> = this._onAnalysisProgress.event;

	constructor(private readonly mainProcessService: IMainProcessService) {
		const channel = this.channel();
		channel.listen<VideoToolsDownloadProgress>('onToolsDownloadProgress')(e => this._onToolsDownloadProgress.fire(e));
		channel.listen<VideoAnalysisProgress>('onAnalysisProgress')(e => this._onAnalysisProgress.fire(e));
	}

	private channel() {
		return this.mainProcessService.getChannel(VIBE_VIDEO_CHANNEL);
	}

	getToolsState(): Promise<VideoToolsState> {
		return this.channel().call('getToolsState');
	}

	ensureTools(): Promise<void> {
		return this.channel().call('ensureTools');
	}

	updateYtDlp(): Promise<string> {
		return this.channel().call('updateYtDlp');
	}

	analyze(options: VideoAnalyzeOptions): Promise<VideoAnalysisResult> {
		return this.channel().call('analyze', options);
	}

	transcribe(requestId: string, profileId: VoiceProfileId): Promise<VideoTranscriptSegment[]> {
		return this.channel().call('transcribe', { requestId, profileId });
	}

	cancel(requestId: string): void {
		this.channel().call('cancel', requestId);
	}

	cleanup(requestId: string): Promise<void> {
		return this.channel().call('cleanup', requestId);
	}
}

// ── Service ──────────────────────────────────────────────────────────────────

class VibeVideoChatService extends Disposable implements IVibeVideoChatService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVibeVideoChatState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly channel: VideoChannelClient;
	private activeRequestId: string | undefined;
	/** Set by the progress notification's cancel — a voluntary stop must not raise error toasts. */
	private cancelRequested = false;

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IVibeModalService private readonly vibeModalService: IVibeModalService,
		@IFileService private readonly fileService: IFileService,
		@IVibeVoiceInputService private readonly voiceInputService: IVibeVoiceInputService,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.channel = new VideoChannelClient(mainProcessService);
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(VIDEO_ENABLED_KEY)) {
				this.fireStateChange();
			}
		}));
	}

	private isEnabled(): boolean {
		return this.configurationService.getValue<boolean>(VIDEO_ENABLED_KEY) !== false;
	}

	getState(): IVibeVideoChatState {
		return { available: this.isEnabled(), running: this.activeRequestId !== undefined };
	}

	private fireStateChange(): void {
		this._onDidChangeState.fire(this.getState());
	}

	cancel(): void {
		if (this.activeRequestId) {
			this.cancelRequested = true;
			this.channel.cancel(this.activeRequestId);
		}
	}

	// ── /watch cycle ─────────────────────────────────────────────────────────

	async startWatch(threadId: string, input: string, userHint: string): Promise<void> {
		const target = input.trim();
		if (!this.isEnabled()) {
			this.notificationService.warn(localize('vibeVideo.disabled', "Просмотр видео выключен настройкой vibeide.video.enabled."));
			return;
		}
		if (!target) {
			this.notificationService.info(localize('vibeVideo.usage', "Использование: /watch <ссылка или путь к видео> [вопрос]. Пример: /watch https://youtu.be/… что показано в демо?"));
			return;
		}
		if (this.activeRequestId) {
			this.notificationService.warn(localize('vibeVideo.busy', "Разбор видео уже идёт — дождитесь окончания или отмените его в уведомлении."));
			return;
		}
		// Extension hint only places the gate and labels progress; the pipeline decides the
		// real kind probe-first (the hint breaks ties for probeless direct links). A
		// hint/probe mismatch is re-checked after the pipeline below.
		const classification = classifyWatchInput(target);
		if (classification !== 'audio' && !await this.checkVisionModel()) {
			return;
		}
		if (!await this.ensureToolsWithConsent()) {
			return;
		}

		const requestId = generateUuid();
		this.activeRequestId = requestId;
		this.cancelRequested = false;
		this.fireStateChange();
		try {
			const prepared = await this.runPipelineWithProgress(requestId, target, classification);
			if (!prepared) {
				return;
			}
			const { result, transcriptText, transcriptLabel } = prepared;
			const isAudio = result.kind === 'audio';
			if (isAudio && !transcriptText) {
				// No frames AND no transcript — there is nothing to analyze at all. Silent
				// on voluntary cancel; the text must not promise that enabling STT fixes it
				// (it may have run and failed, or the profile has no batch model).
				if (!this.cancelRequested) {
					this.notificationService.error(localize('vibeVideo.audioNoTranscript', "Не удалось получить транскрипт аудио: субтитров нет, а локальное распознавание недоступно или не справилось. Без транскрипта разбирать нечего."));
				}
				return;
			}
			if (!isAudio && classification === 'audio' && !await this.checkVisionModel()) {
				// The extension said audio (gate was skipped) but the probe found real video —
				// e.g. a renamed .mp3. Late but polite: the same refusal the chat send would
				// otherwise raise as a hard block.
				return;
			}
			const images = isAudio ? [] : await this.buildImageAttachments(result);
			const userMessage = this.composePrompt(target, userHint, result, transcriptText, transcriptLabel, images.length);
			const attachmentsNote = isAudio
				? localize('vibeVideo.display.audio', "аудио, транскрипт: {0}", transcriptLabel)
				: localize('vibeVideo.display.video', "кадров: {0}, транскрипт: {1}", images.length, transcriptLabel);
			const displayContent = `/watch ${target}${userHint ? ` — ${userHint}` : ''}\n(${attachmentsNote})`;
			await this.chatThreadService.addUserMessageAndStreamResponse({ userMessage, threadId, images, displayContent });
		} catch (error) {
			this.reportPipelineError(error);
		} finally {
			await this.channel.cleanup(requestId).catch(() => undefined);
			this.activeRequestId = undefined;
			this.fireStateChange();
		}
	}

	/** Early vision gate — mirrors the chatThreadService image hard-block, but BEFORE the pipeline. */
	private async checkVisionModel(): Promise<boolean> {
		const selection = this.settingsService.state.modelSelectionOfFeature['Chat'];
		if (!selection || (selection.providerName === 'auto' && selection.modelName === 'auto')) {
			// Auto mode: the router picks the model later; chatThreadService still guards the send.
			return true;
		}
		const capabilities = getModelCapabilities(selection.providerName, selection.modelName, this.settingsService.state.overridesOfModel);
		if (isModelVisionCapable(selection, capabilities)) {
			return true;
		}
		this.notificationService.error(localize('vibeVideo.noVision', "Выбранная модель чата ({0}/{1}) не поддерживает изображения — разбор видео невозможен. Переключитесь на vision-модель (Claude, GPT-4o/4.1/5, Gemini и т.п.) и повторите /watch.", selection.providerName, selection.modelName));
		return false;
	}

	private async ensureToolsWithConsent(): Promise<boolean> {
		let state: VideoToolsState;
		try {
			state = await this.channel.getToolsState();
		} catch (error) {
			this.notificationService.error(localize('vibeVideo.channelError', "Видео-пайплайн недоступен: {0}", error instanceof Error ? error.message : String(error)));
			return false;
		}
		if (state.state === 'ready') {
			return true;
		}
		if (state.state === 'missing' && state.downloadBytes === 0) {
			this.notificationService.error(localize('vibeVideo.unsupportedPlatform', "Просмотр видео недоступен: для этой платформы нет сборки инструментов (yt-dlp/ffmpeg)."));
			return false;
		}
		if (state.state === 'missing') {
			const megabytes = bytesToMegabytes(state.downloadBytes);
			const consented = await this.vibeModalService.confirmModal({
				title: localize('vibeVideo.confirmTools', "Скачать инструменты для просмотра видео?"),
				body: localize('vibeVideo.confirmToolsDetail', "Будет загружено ~{0} МБ (однократно) — yt-dlp и ffmpeg для скачивания видео и нарезки кадров. Инструменты сохранятся в данных пользователя; сами видео обрабатываются локально и никуда не отправляются, кроме кадров и транскрипта, уходящих выбранной модели чата.", megabytes),
				icon: 'device-camera-video',
				okLabel: localize('vibeVideo.confirmToolsYes', "Скачать"),
				cancelLabel: localize('vibeVideo.confirmToolsNo', "Отмена"),
			});
			if (!consented) {
				return false;
			}
		}
		// 'downloading' joins the run already in flight (main-side ensureTools dedupes).
		try {
			await this.progressService.withProgress(
				{
					location: ProgressLocation.Notification,
					title: localize('vibeVideo.downloadingTools', "Загрузка инструментов видео ({0} МБ)…", bytesToMegabytes(state.downloadBytes)),
				},
				async progress => {
					let lastPercent = 0;
					const subscription = this.channel.onToolsDownloadProgress(e => {
						if (e.done || e.totalBytes === 0) {
							return;
						}
						const percent = Math.min(100, Math.round(e.receivedBytes / e.totalBytes * 100));
						progress.report({ increment: percent - lastPercent, message: `${percent}%` });
						lastPercent = percent;
					});
					try {
						await this.channel.ensureTools();
					} finally {
						subscription.dispose();
					}
				},
			);
			return true;
		} catch (error) {
			this.notificationService.error(localize('vibeVideo.toolsFailed', "Не удалось скачать инструменты видео: {0}", error instanceof Error ? error.message : String(error)));
			return false;
		}
	}

	private stageLabel(progress: VideoAnalysisProgress): string {
		const labels: Record<VideoAnalysisStage, string> = {
			probe: localize('vibeVideo.stage.probe', "читаю метаданные"),
			subtitles: localize('vibeVideo.stage.subtitles', "ищу субтитры"),
			// Neutral wording — the same stage downloads a video or a bare audio track.
			download: localize('vibeVideo.stage.download', "скачиваю"),
			frames: localize('vibeVideo.stage.frames', "нарезаю кадры по сменам сцен"),
			audio: localize('vibeVideo.stage.audio', "распознаю звук"),
		};
		const label = labels[progress.stage];
		return progress.percent !== undefined ? `${label} — ${progress.percent}%` : label;
	}

	private async runPipelineWithProgress(requestId: string, target: string, classification: 'audio' | 'video' | 'unknown'): Promise<{ result: VideoAnalysisResult; transcriptText: string | undefined; transcriptLabel: string } | undefined> {
		return this.progressService.withProgress(
			{
				location: ProgressLocation.Notification,
				title: classification === 'audio'
					? localize('vibeVideo.listening', "Слушаю аудио…")
					: localize('vibeVideo.watching', "Смотрю видео…"),
				cancellable: true,
			},
			async progress => {
				const subscription = this.channel.onAnalysisProgress(e => {
					if (e.requestId === requestId) {
						progress.report({ message: this.stageLabel(e) });
					}
				});
				try {
					const result = await this.channel.analyze({ requestId, input: target });
					let transcriptText: string | undefined;
					let transcriptLabel: string;
					if (result.transcriptSrt) {
						transcriptText = result.transcriptSrt;
						transcriptLabel = localize('vibeVideo.transcript.subtitles', "субтитры");
					} else if (result.audioPcmPath) {
						transcriptText = await this.transcribeWithSttFallback(requestId, result.kind === 'audio');
						transcriptLabel = transcriptText
							? localize('vibeVideo.transcript.stt', "распознан локально")
							: localize('vibeVideo.transcript.none', "нет");
					} else {
						transcriptLabel = localize('vibeVideo.transcript.noAudio', "нет звуковой дорожки");
					}
					return { result, transcriptText, transcriptLabel };
				} finally {
					subscription.dispose();
				}
			},
			() => this.cancel(),
		);
	}

	/** No subtitles: try the local STT (its models may need their own consent + download). */
	private async transcribeWithSttFallback(requestId: string, isAudio: boolean): Promise<string | undefined> {
		try {
			const voiceState = this.voiceInputService.getState();
			if (!voiceState.available) {
				return undefined;
			}
			if (voiceState.modelState !== 'ready' && !await this.voiceInputService.ensureModelsReady()) {
				return undefined;
			}
			const segments = await this.channel.transcribe(requestId, this.voiceInputService.getActiveProfileId());
			if (segments.length === 0) {
				return undefined;
			}
			return segments
				.map(s => `[${formatVideoTimecode(s.startSec)}–${formatVideoTimecode(s.endSec)}] ${s.text}`)
				.join('\n');
		} catch (error) {
			this.logService.warn(`[vibeVideo] STT fallback failed: ${error instanceof Error ? error.message : String(error)}`);
			// «Only frames» is a lie for the audio branch (no frames — startWatch raises its
			// own error), and a voluntary cancel needs no toast at all.
			if (!isAudio && !this.cancelRequested) {
				this.notificationService.warn(localize('vibeVideo.sttFailed', "Не удалось распознать звук видео — разбор пойдёт только по кадрам."));
			}
			return undefined;
		}
	}

	private async buildImageAttachments(result: VideoAnalysisResult): Promise<ChatImageAttachment[]> {
		const attachments: ChatImageAttachment[] = [];
		for (const frame of result.frames) {
			const content = await this.fileService.readFile(URI.file(frame.path));
			attachments.push({
				id: generateUuid(),
				data: content.value.buffer,
				mimeType: 'image/jpeg',
				filename: `frame-${formatVideoTimecode(frame.timeSec).replace(/:/g, '-')}.jpg`,
				width: frame.width,
				height: frame.height,
				size: frame.sizeBytes,
				uploadStatus: 'success',
			});
		}
		return attachments;
	}

	private composePrompt(target: string, userHint: string, result: VideoAnalysisResult, transcriptText: string | undefined, transcriptLabel: string, imageCount: number): string {
		const isAudio = result.kind === 'audio';
		const lines: string[] = [];
		lines.push(isAudio ? 'Разбор аудиозаписи по команде /watch.' : 'Разбор видео по команде /watch.');
		lines.push(`Источник: ${target}`);
		if (result.title) {
			lines.push(`Название: ${result.title}`);
		}
		if (result.durationSec !== undefined) {
			lines.push(`Длительность: ${formatVideoTimecode(result.durationSec)}`);
		}
		lines.push('');
		if (!isAudio) {
			lines.push(`К сообщению приложены ${imageCount} кадров, вырезанных по сменам сцен (в порядке времени). Соответствие кадров тайм-кодам:`);
			result.frames.forEach((frame, index) => {
				lines.push(`Кадр ${index + 1} — ${formatVideoTimecode(frame.timeSec)}`);
			});
			lines.push('');
		}
		if (transcriptText) {
			const truncated = transcriptText.length > MAX_PROMPT_TRANSCRIPT_CHARS;
			lines.push(`Транскрипт (${transcriptLabel}${truncated ? '; обрезан по лимиту' : ''}):`);
			lines.push(truncated ? transcriptText.slice(0, MAX_PROMPT_TRANSCRIPT_CHARS) : transcriptText);
		} else {
			// Unreachable for audio — startWatch aborts an audio run without a transcript.
			lines.push(`Транскрипта нет (${transcriptLabel}) — анализируй только кадры.`);
		}
		lines.push('');
		if (userHint) {
			lines.push(`Задание: ${userHint}`);
		} else {
			lines.push(isAudio
				? 'Задание: составь разбор аудиозаписи: 1) TL;DR в 3–5 строк; 2) ключевые темы и тезисы с тайм-кодами; 3) кто говорит — атрибутируй по содержанию и явно помечай неуверенность (авто-транскрипт спикеров не размечает); 4) заметные цитаты с тайм-кодами.'
				: 'Задание: составь разбор видео: 1) TL;DR в 3–5 строк; 2) ключевые моменты с тайм-кодами; 3) что показано на экране, но не проговорено в звуке; 4) заметные цитаты/моменты с тайм-кодами. Ссылайся на кадры по номерам и тайм-кодам.');
		}
		return lines.join('\n');
	}

	private reportPipelineError(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (/yt-dlp/i.test(message)) {
			// YouTube regularly breaks old yt-dlp builds — offer the self-update right away.
			this.notificationService.prompt(
				Severity.Error,
				localize('vibeVideo.ytDlpFailed', "Не удалось получить видео: {0}. Частая причина — устаревший yt-dlp.", message),
				[{
					label: localize('vibeVideo.updateYtDlp', "Обновить yt-dlp"),
					run: async () => {
						try {
							const report = await this.channel.updateYtDlp();
							this.notificationService.info(localize('vibeVideo.ytDlpUpdated', "yt-dlp: {0}. Повторите /watch.", report));
						} catch (updateError) {
							this.notificationService.error(localize('vibeVideo.ytDlpUpdateFailed', "Не удалось обновить yt-dlp: {0}", updateError instanceof Error ? updateError.message : String(updateError)));
						}
					},
				}],
			);
			return;
		}
		this.notificationService.error(localize('vibeVideo.failed', "Разбор видео не удался: {0}", message));
	}
}

registerSingleton(IVibeVideoChatService, VibeVideoChatService, InstantiationType.Delayed);
