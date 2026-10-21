/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Движок просмотра записей — десктопная реализация (контракт: `common/video/vibeWatchMediaService.ts`)
 *
 * Полный цикл, общий для команды `/watch` и инструментов модели:
 *
 * 1. Гейт vision ДО любой работы (только когда кадры уйдут картинками): модель без зрения отказывает сразу,
 *    а не после минут скачивания. Ввод, похожий на аудио, гейт пропускает: картинок в его запросе нет
 * 2. Согласие на инструменты и их скачивание (yt-dlp и ffmpeg с зеркала `video-tools-v1`) — той же схемой,
 *    что модели распознавания речи: размер назван в модалке VibeIDE, молча ничего не качается
 * 3. Конвейер главного процесса по каналу `vibeide-channel-video`, с уведомлением о ходе, которое можно отменить
 * 4. Субтитров нет — распознавание речи через голосовой фасад (у него своё согласие на модели)
 * 5. Дальше разбор отдаётся вызывающему: `/watch` кладёт кадры в чат, инструмент собирает ответ текстом
 *
 * Кадры в ответе инструмента: картинок в ответе инструмента основного чата нет, поэтому кадры рассматривает
 * отдельный запрос к vision-модели, а в ответ идёт текст. Внешнему агенту кадры отдаются самими картинками
 */

import { localize } from '../../../../../nls.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer, encodeBase64 } from '../../../../../base/common/buffer.js';
import { basename } from '../../../../../base/common/path.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IAgentNetworkFilterService } from '../../../../../platform/networkFilter/common/networkFilterService.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IVibeModalService } from '../../common/vibeModalService.js';
import { IVibeVideoChatState } from '../../common/video/vibeVideoChatService.js';
import { IPreparedWatch, IVibeWatchMediaService, IWatchFrameBytes, IWatchRunOptions, IWatchToolImage, IWatchToolReport, IWatchToolRequest, WatchRun, WatchStop } from '../../common/video/vibeWatchMediaService.js';
import { VIBE_VIDEO_CHANNEL, VideoAnalysisProgress, VideoAnalysisResult, VideoAnalysisStage, VideoAnalyzeOptions, VideoToolsDownloadProgress, VideoToolsState, VideoTranscriptSegment, formatVideoTimecode, selectEvenlySpreadFrames } from '../../common/video/vibeVideoTypes.js';
import { classifyWatchInput, isRemoteVideoInput, resolveWatchTarget, WatchTargetResolution } from '../../common/video/vibeVideoTools.js';
import { VIDEO_ENABLED_KEY, VIDEO_FRAME_MODEL_KEY, VIDEO_TOOL_MAX_FRAMES_KEY, clampVideoToolMaxFrames } from '../../common/video/vibeVideoConfiguration.js';
import { IWatchedMedia, WatchFrameReport, composeFrameDescriptionPrompt, composeWatchToolReport, parseFrameDescriptions } from '../../common/video/watchMediaReport.js';
import { IVibeVoiceInputService } from '../../common/voice/vibeVoiceInputService.js';
import { VoiceProfileId } from '../../common/voice/vibeVoiceTypes.js';
import { IVibeideSettingsService } from '../../common/vibeideSettingsService.js';
import { ModelSelection } from '../../common/vibeideSettingsTypes.js';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { isModelVisionCapable } from '../../common/modelVisionHeuristics.js';
import { parseModelRef } from '../../common/pipeline/vibePipelineFile.js';
import { ILLMMessageService } from '../../common/sendLLMMessageService.js';
import { OfflinePrivacyGate } from '../../common/offlinePrivacyGate.js';
import { ChatImageAttachment, ChatMessage } from '../../common/chatThreadServiceTypes.js';
import { IConvertToLLMMessageService } from '../../browser/convertToLLMMessageService.js';

/** Сколько ждать описания кадров: десяток картинок — запрос не быстрый, но минуты без ответа значат, что он завис */
const DESCRIBE_FRAMES_TIMEOUT_MS = 180_000;

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

const refused = (severity: 'info' | 'warn' | 'error', message: string): WatchStop => ({ kind: 'refused', severity, message });
const CANCELLED: WatchStop = { kind: 'cancelled' };

// ── Service ──────────────────────────────────────────────────────────────────

class VibeWatchMediaService extends Disposable implements IVibeWatchMediaService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<IVibeVideoChatState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly channel: VideoChannelClient;
	private activeRequestId: string | undefined;
	/** Set by the progress notification's cancel — a voluntary stop must not raise error toasts. */
	private cancelRequested = false;
	private readonly offlineGate = new OfflinePrivacyGate();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IProgressService private readonly progressService: IProgressService,
		@IVibeModalService private readonly vibeModalService: IVibeModalService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@IVibeVoiceInputService private readonly voiceInputService: IVibeVoiceInputService,
		@IVibeideSettingsService private readonly settingsService: IVibeideSettingsService,
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService,
		@IAgentNetworkFilterService private readonly networkFilter: IAgentNetworkFilterService,
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

	// ── Один разбор ──────────────────────────────────────────────────────────

	async run<T>(options: IWatchRunOptions, consume: (prepared: IPreparedWatch) => Promise<T>): Promise<WatchRun<T>> {
		const typed = options.input.trim();
		if (!this.isEnabled()) {
			return refused('warn', localize('vibeVideo.disabled', "Просмотр видео выключен настройкой vibeide.video.enabled."));
		}
		if (this.activeRequestId) {
			return refused('warn', localize('vibeVideo.busy', "Разбор видео уже идёт — дождитесь окончания или отмените его в уведомлении."));
		}
		// Файл ищем до гейтов: не найденный путь не должен сначала просить модель и скачивание инструментов.
		const resolution = await this.resolveTarget(typed);
		if (resolution.kind === 'missing') {
			return refused('error', this.missingTargetMessage(typed, resolution));
		}
		const target = resolution.target;
		const denial = await options.authorize?.(target);
		if (denial) {
			return refused('error', denial);
		}
		// Extension hint only places the gate and labels progress; the pipeline decides the
		// real kind probe-first (the hint breaks ties for probeless direct links). A
		// hint/probe mismatch is re-checked after the pipeline below.
		const classification = classifyWatchInput(target);
		if (options.requireVision && classification !== 'audio') {
			const noVision = this.visionRefusal();
			if (noVision) {
				return noVision;
			}
		}
		const toolsStop = await this.ensureToolsWithConsent();
		if (toolsStop) {
			return toolsStop;
		}

		const requestId = generateUuid();
		this.activeRequestId = requestId;
		this.cancelRequested = false;
		this.fireStateChange();
		try {
			let prepared: Awaited<ReturnType<VibeWatchMediaService['runPipelineWithProgress']>>;
			try {
				prepared = await this.runPipelineWithProgress(requestId, target, classification);
			} catch (error) {
				// Конвейер, остановленный самим человеком, бросает «отменён»: это не сбой, и тревожить об этом нечем
				if (this.cancelRequested) {
					return CANCELLED;
				}
				throw error;
			}
			if (!prepared) {
				return CANCELLED;
			}
			const { result, transcriptText, transcriptLabel } = prepared;
			const isAudio = result.kind === 'audio';
			if (isAudio && !transcriptText) {
				// No frames AND no transcript — there is nothing to analyze at all. Silent
				// on voluntary cancel; the text must not promise that enabling STT fixes it
				// (it may have run and failed, or the profile has no batch model).
				return this.cancelRequested
					? CANCELLED
					: refused('error', localize('vibeVideo.audioNoTranscript', "Не удалось получить транскрипт аудио: субтитров нет, а локальное распознавание недоступно или не справилось. Без транскрипта разбирать нечего."));
			}
			if (!isAudio && classification === 'audio' && options.requireVision) {
				// The extension said audio (gate was skipped) but the probe found real video —
				// e.g. a renamed .mp3. Late but polite: the same refusal the chat send would
				// otherwise raise as a hard block.
				const noVision = this.visionRefusal();
				if (noVision) {
					return noVision;
				}
			}
			const media: IWatchedMedia = {
				target,
				kind: result.kind,
				title: result.title,
				durationSec: result.durationSec,
				frameTimes: result.frames.map(frame => frame.timeSec),
				transcriptText,
				transcriptLabel,
			};
			const value = await consume({ media, result, readFrames: indices => this.readFrames(result, indices) });
			return { kind: 'done', value };
		} finally {
			await this.channel.cleanup(requestId).catch(() => undefined);
			this.activeRequestId = undefined;
			this.fireStateChange();
		}
	}

	/**
	 * Путь разрешаем здесь, а не в main-процессе: там `existsSync` смотрит от cwd Electron,
	 * а не от папки проекта, и уведомление о «не найден» не могло бы назвать, где искали.
	 */
	private async resolveTarget(typed: string): Promise<WatchTargetResolution> {
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders.map(folder => folder.uri.fsPath);
		const home = await this.pathService.userHome();
		return resolveWatchTarget(typed, {
			workspaceFolders,
			homeDir: home.fsPath,
			isFile: async absolutePath => {
				try {
					return (await this.fileService.stat(URI.file(absolutePath))).isFile;
				} catch {
					return false;
				}
			},
		});
	}

	private missingTargetMessage(typed: string, resolution: Extract<WatchTargetResolution, { readonly kind: 'missing' }>): string {
		if (resolution.scope !== 'project') {
			return resolution.scope === 'home'
				? localize('vibeVideo.fileNotInHome', "Не нашёл {0} в домашней папке.", typed)
				: localize('vibeVideo.fileNotFound', "Файл не найден: {0}.", typed);
		}
		const { folders } = resolution;
		if (folders.length === 0) {
			return localize('vibeVideo.noWorkspaceFolder', "Не нашёл {0}: папка проекта не открыта. Откройте папку или укажите полный путь к файлу.", typed);
		}
		if (folders.length === 1) {
			return localize('vibeVideo.fileNotInProject', "Не нашёл {0} в корне проекта {1}. Если файл в другом месте, укажите полный путь.", typed, basename(folders[0]));
		}
		return localize('vibeVideo.fileNotInProjects', "Не нашёл {0} ни в одной папке проекта: {1}.", typed, folders.join(', '));
	}

	/** Early vision gate — mirrors the chatThreadService image hard-block, but BEFORE the pipeline. */
	private visionRefusal(): WatchStop | undefined {
		const selection = this.settingsService.state.modelSelectionOfFeature['Chat'];
		if (!selection || (selection.providerName === 'auto' && selection.modelName === 'auto')) {
			// Auto mode: the router picks the model later; chatThreadService still guards the send.
			return undefined;
		}
		const capabilities = getModelCapabilities(selection.providerName, selection.modelName, this.settingsService.state.overridesOfModel);
		if (isModelVisionCapable(selection, capabilities)) {
			return undefined;
		}
		return refused('error', localize('vibeVideo.noVision', "Выбранная модель чата ({0}/{1}) не поддерживает изображения — разбор видео невозможен. Переключитесь на vision-модель (Claude, GPT-4o/4.1/5, Gemini и т.п.) и повторите /watch.", selection.providerName, selection.modelName));
	}

	/** Инструменты готовы — `undefined`; иначе причина, по которой разбирать нечем */
	private async ensureToolsWithConsent(): Promise<WatchStop | undefined> {
		let state: VideoToolsState;
		try {
			state = await this.channel.getToolsState();
		} catch (error) {
			return refused('error', localize('vibeVideo.channelError', "Видео-пайплайн недоступен: {0}", error instanceof Error ? error.message : String(error)));
		}
		if (state.state === 'ready') {
			return undefined;
		}
		if (state.state === 'missing' && state.downloadBytes === 0) {
			return refused('error', localize('vibeVideo.unsupportedPlatform', "Просмотр видео недоступен: для этой платформы нет сборки инструментов (yt-dlp/ffmpeg)."));
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
				return CANCELLED;
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
			return undefined;
		} catch (error) {
			return refused('error', localize('vibeVideo.toolsFailed', "Не удалось скачать инструменты видео: {0}", error instanceof Error ? error.message : String(error)));
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
			// Batch needs only the offline model, not the whole dictation bundle (English
			// dictation is a separate streaming model). The tier for English (small/medium)
			// is a `vibeide.voice.englishBatchModel` setting resolved main-side.
			const profileId = this.voiceInputService.getActiveProfileId();
			if (!await this.voiceInputService.ensureBatchModelReady(profileId)) {
				return undefined;
			}
			const segments = await this.channel.transcribe(requestId, profileId);
			if (segments.length === 0) {
				return undefined;
			}
			return segments
				.map(s => `[${formatVideoTimecode(s.startSec)}–${formatVideoTimecode(s.endSec)}] ${s.text}`)
				.join('\n');
		} catch (error) {
			this.logService.warn(`[vibeVideo] STT fallback failed: ${error instanceof Error ? error.message : String(error)}`);
			// «Only frames» is a lie for the audio branch (no frames — the run raises its
			// own error), and a voluntary cancel needs no toast at all.
			if (!isAudio && !this.cancelRequested) {
				this.notificationService.warn(localize('vibeVideo.sttFailed', "Не удалось распознать звук видео — разбор пойдёт только по кадрам."));
			}
			return undefined;
		}
	}

	private async readFrames(result: VideoAnalysisResult, indices?: readonly number[]): Promise<readonly IWatchFrameBytes[]> {
		const chosen = indices ?? result.frames.map((_, index) => index);
		const frames: IWatchFrameBytes[] = [];
		for (const index of chosen) {
			const frame = result.frames[index];
			if (!frame) {
				continue;
			}
			const content = await this.fileService.readFile(URI.file(frame.path));
			frames.push({ timeSec: frame.timeSec, width: frame.width, height: frame.height, sizeBytes: frame.sizeBytes, data: content.value.buffer });
		}
		return frames;
	}

	// ── Инструмент модели ────────────────────────────────────────────────────

	async forTool(request: IWatchToolRequest): Promise<IWatchToolReport> {
		const typed = request.input.trim();
		if (!typed) {
			throw new Error(localize('vibeVideo.toolNoSource', "Не указан источник: нужен путь к файлу или ссылка."));
		}
		if (isRemoteVideoInput(typed)) {
			// Ссылку просит открыть агент, а качает IDE: действуют те же запреты, что у browse_url, — автономный режим и сетевой фильтр пользователя
			this.offlineGate.ensureNotOfflineOrPrivacy('Video watching', false);
			const requested = URI.parse(typed);
			if (!this.networkFilter.isUriAllowed(requested)) {
				throw new Error(this.networkFilter.formatError(requested));
			}
		}
		let outcome: WatchRun<IWatchToolReport>;
		try {
			outcome = await this.run({ input: request.input, requireVision: false, authorize: request.authorize }, prepared => this.reportOf(prepared, request));
		} catch (error) {
			// Сбой конвейера: ответ инструмента называет причину, а для устаревшего yt-dlp человеку ещё и предлагается обновление
			const message = error instanceof Error ? error.message : String(error);
			if (/yt-dlp/i.test(message)) {
				this.offerYtDlpUpdate(message);
			}
			throw new Error(localize('vibeVideo.toolFailed', "Разбор записи не удался: {0}", message));
		}
		if (outcome.kind === 'done') {
			return outcome.value;
		}
		throw new Error(outcome.kind === 'refused' ? outcome.message : localize('vibeVideo.toolCancelled', "Разбор записи остановлен человеком."));
	}

	private async reportOf(prepared: IPreparedWatch, request: IWatchToolRequest): Promise<IWatchToolReport> {
		const { media } = prepared;
		const maxFrames = clampVideoToolMaxFrames(this.configurationService.getValue(VIDEO_TOOL_MAX_FRAMES_KEY));
		// Кадры аудио нет; у видео берём не больше предела и равномерно по времени: каждый кадр — картинка в запросе
		const picked = media.kind === 'video'
			? selectEvenlySpreadFrames(media.frameTimes.map((_, index) => index), maxFrames)
			: [];
		const shown: IWatchedMedia = { ...media, frameTimes: picked.map(index => media.frameTimes[index]) };
		let frames: WatchFrameReport = { kind: 'unseen', reason: '' };
		let images: IWatchToolImage[] = [];
		if (picked.length > 0) {
			const bytes = await prepared.readFrames(picked);
			if (request.frames === 'attach') {
				frames = { kind: 'attached' };
				images = bytes.map(frame => ({ mimeType: 'image/jpeg', data: encodeBase64(VSBuffer.wrap(frame.data)), timeSec: frame.timeSec }));
			} else {
				frames = await this.describeFrames(bytes, shown.frameTimes, request.question);
			}
		}
		return {
			text: composeWatchToolReport(shown, frames, request.question),
			kind: media.kind,
			title: media.title,
			durationSec: media.durationSec,
			frameCount: picked.length,
			describedBy: frames.kind === 'described' ? frames.model : undefined,
			images,
		};
	}

	/** Кто рассмотрит кадры: модель из настройки, иначе модель чата — если выбрана явно и умеет смотреть изображения */
	private frameModel(): { readonly selection: ModelSelection } | { readonly reason: string } {
		const configured = (this.configurationService.getValue<string>(VIDEO_FRAME_MODEL_KEY) ?? '').trim();
		let selection: ModelSelection | null;
		if (configured) {
			const ref = parseModelRef(configured);
			if (!ref) {
				return { reason: localize('vibeVideo.frameModel.bad', "настройка {0} задана не в форме «провайдер/модель»: «{1}».", VIDEO_FRAME_MODEL_KEY, configured) };
			}
			selection = { providerName: ref.providerName, modelName: ref.modelName } as ModelSelection;
		} else {
			selection = this.settingsService.state.modelSelectionOfFeature['Chat'];
			if (!selection || (selection.providerName === 'auto' && selection.modelName === 'auto')) {
				return { reason: localize('vibeVideo.frameModel.auto', "модель чата — «Авто», а кадры должна рассматривать конкретная vision-модель; задайте её настройкой {0}.", VIDEO_FRAME_MODEL_KEY) };
			}
		}
		const capabilities = getModelCapabilities(selection.providerName, selection.modelName, this.settingsService.state.overridesOfModel);
		if (!isModelVisionCapable(selection, capabilities)) {
			return { reason: localize('vibeVideo.frameModel.noVision', "модель {0}/{1} не умеет смотреть изображения; задайте vision-модель настройкой {2}.", selection.providerName, selection.modelName, VIDEO_FRAME_MODEL_KEY) };
		}
		return { selection };
	}

	/** Кадры → один запрос к vision-модели: по строке на кадр. Не вышло — ответ инструмента остаётся с тайм-кодами и называет причину */
	private async describeFrames(frames: readonly IWatchFrameBytes[], times: readonly number[], question: string): Promise<WatchFrameReport> {
		const model = this.frameModel();
		if ('reason' in model) {
			return { kind: 'unseen', reason: model.reason };
		}
		const label = `${model.selection.providerName}/${model.selection.modelName}`;
		try {
			const cancellation = new CancellationTokenSource();
			let answer: string;
			try {
				answer = await this.progressService.withProgress(
					{
						location: ProgressLocation.Notification,
						title: localize('vibeVideo.describing', "Рассматриваю кадры ({0})…", frames.length),
						cancellable: true,
					},
					() => this.askToDescribe(model.selection, frames, times, question, cancellation.token),
					() => cancellation.cancel(),
				);
			} finally {
				cancellation.dispose();
			}
			const descriptions = parseFrameDescriptions(answer, frames.length);
			if (descriptions.size === 0) {
				return { kind: 'unseen', reason: localize('vibeVideo.describe.unparsed', "модель {0} ответила не по формату «N: что видно».", label) };
			}
			return { kind: 'described', model: label, descriptions };
		} catch (error) {
			this.logService.warn(`[vibeVideo] frame description failed: ${error instanceof Error ? error.message : String(error)}`);
			return { kind: 'unseen', reason: localize('vibeVideo.describe.failed', "запрос к модели {0} не удался: {1}.", label, error instanceof Error ? error.message : String(error)) };
		}
	}

	private async askToDescribe(selection: ModelSelection, frames: readonly IWatchFrameBytes[], times: readonly number[], question: string, token: CancellationToken): Promise<string> {
		const prompt = composeFrameDescriptionPrompt(times, question);
		const images: ChatImageAttachment[] = frames.map((frame, index) => ({
			id: generateUuid(),
			data: frame.data,
			mimeType: 'image/jpeg',
			filename: `frame-${index + 1}.jpg`,
			width: frame.width,
			height: frame.height,
			size: frame.sizeBytes,
			uploadStatus: 'success',
		}));
		const message: ChatMessage = { role: 'user', content: prompt, displayContent: prompt, selections: null, images, state: { stagingSelections: [], isBeingEdited: false } };
		const { messages, separateSystemMessage } = await this.convertToLLMMessageService.prepareLLMChatMessages({
			chatMessages: [message],
			chatMode: 'normal',
			modelSelection: selection,
			// Разовый запрос не должен затирать счётчик контекста открытого треда
			skipContextGuardUpdate: true,
		});
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let listener: { dispose(): void } | undefined;
			const finish = (outcome: { text?: string; error?: string }) => {
				if (settled) { return; }
				settled = true;
				if (timer !== undefined) { clearTimeout(timer); }
				listener?.dispose();
				if (outcome.error !== undefined) { reject(new Error(outcome.error)); } else { resolve(outcome.text ?? ''); }
			};
			const requestId = this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage,
				chatMode: 'normal',
				modelSelection: selection,
				modelSelectionOptions: undefined,
				overridesOfModel: this.settingsService.state.overridesOfModel,
				onText: () => { },
				onFinalMessage: payload => finish({ text: payload.fullText }),
				onError: error => finish({ error: error.message || String(error) }),
				onAbort: () => finish({ error: localize('vibeVideo.describe.aborted', "запрос прерван") }),
				logging: { loggingName: `WatchFrames/${selection.providerName}` },
			});
			if (requestId === null) {
				finish({ error: localize('vibeVideo.describe.notAccepted', "провайдер не принял запрос") });
				return;
			}
			timer = setTimeout(() => {
				this.llmMessageService.abort(requestId);
				finish({ error: localize('vibeVideo.describe.timeout', "нет ответа за {0} с", DESCRIBE_FRAMES_TIMEOUT_MS / 1000) });
			}, DESCRIBE_FRAMES_TIMEOUT_MS);
			listener = token.onCancellationRequested(() => this.llmMessageService.abort(requestId));
		});
	}

	// ── Сбои ─────────────────────────────────────────────────────────────────

	reportFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (/yt-dlp/i.test(message)) {
			this.offerYtDlpUpdate(message);
			return;
		}
		this.notificationService.error(localize('vibeVideo.failed', "Разбор видео не удался: {0}", message));
	}

	/** YouTube regularly breaks old yt-dlp builds — offer the self-update right away. */
	private offerYtDlpUpdate(message: string): void {
		this.notificationService.prompt(
			Severity.Error,
			localize('vibeVideo.ytDlpFailed', "Не удалось получить видео: {0}. Частая причина — устаревший yt-dlp.", message),
			[{
				label: localize('vibeVideo.updateYtDlp', "Обновить yt-dlp"),
				run: async () => {
					try {
						const report = await this.channel.updateYtDlp();
						this.notificationService.info(localize('vibeVideo.ytDlpUpdated', "yt-dlp: {0}. Повторите разбор.", report));
					} catch (updateError) {
						this.notificationService.error(localize('vibeVideo.ytDlpUpdateFailed', "Не удалось обновить yt-dlp: {0}", updateError instanceof Error ? updateError.message : String(updateError)));
					}
				},
			}],
		);
	}
}

registerSingleton(IVibeWatchMediaService, VibeWatchMediaService, InstantiationType.Delayed);
