/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — main-process side: tools store (yt-dlp + ffmpeg downloaded on
 * first use, SHA256-verified) and the extraction pipeline. Exposed to the renderer via
 * `video/vibeVideoChannel.ts` (raw channel — download and stage progress are push streams).
 *
 * The pipeline spawns the tools as child processes (crash isolation for free — no utility
 * process needed, unlike the N-API STT worker): yt-dlp fetches subtitles and a ≤N-p video,
 * ffmpeg extracts scene-change frames as JPEG with `showinfo` timecodes. Videos without
 * subtitles get their audio extracted as raw PCM16; the renderer may then request the STT
 * fallback, which delegates to `voice/vibeVoiceMainService.ts` (GigaAM offline batch decode).
 *
 * Audio-only inputs (podcast, mp3, voice message) take a frameless branch. Probe-first:
 * local — `ffmpeg -i` stream layout (cover art excluded); remote — every format
 * `vcodec: none`; the URL's audio extension breaks the tie only when the remote probe has
 * no codec info at all (generic extractor, e.g. a direct mp3 link) — positive video
 * evidence always wins. Subtitles short-circuit the download entirely, otherwise
 * bestaudio → PCM16 for the same STT fallback. The result carries `kind: 'audio'` and an
 * empty frame list.
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync, promises as fsPromises } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'path' in an electron-main service (by design)
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IEnvironmentMainService } from '../../../../../platform/environment/electron-main/environmentMainService.js';
import { VideoAnalysisProgress, VideoAnalysisResult, VideoAnalysisStage, VideoAnalyzeOptions, VideoFrameInfo, VideoToolsDownloadProgress, VideoToolsState, VideoTranscriptSegment, selectEvenlySpreadFrames } from '../../common/video/vibeVideoTypes.js';
import { VideoToolsArchive, VIDEO_TOOLS_DIR, classifyWatchInput, isRemoteVideoInput, resolveVideoToolPaths, videoToolsArchiveForPlatform } from '../../common/video/vibeVideoTools.js';
import { VIDEO_FRAME_HEIGHT_KEY, VIDEO_MAX_FRAMES_KEY, VIDEO_SCENE_THRESHOLD_KEY, VIDEO_SUBTITLE_LANGUAGES_KEY, VIDEO_TOOLS_PATH_KEY, clampVideoFrameHeight, clampVideoMaxFrames, clampVideoSceneThreshold, normalizeVideoSubtitleLanguages } from '../../common/video/vibeVideoConfiguration.js';
import { VoiceProfileId } from '../../common/voice/vibeVoiceTypes.js';
import { downloadWithSha256 } from '../vibeVerifiedDownload.js';
import { VibeVoiceMainService } from '../voice/vibeVoiceMainService.js';

/** Download progress push throttle (bytes) — keeps the IPC event stream sparse. */
const PROGRESS_EMIT_STEP_BYTES = 1024 * 1024;
/** Fewer scene frames than this → one retry with the low threshold (static screencasts). */
const MIN_USEFUL_FRAMES = 3;
const RETRY_SCENE_THRESHOLD = 0.1;
/** Subtitle files above this are cut — beyond any real subtitle track, guards the prompt. */
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
/** Cap on collected child stdout/stderr (yt-dlp JSON probe is the largest legit payload). */
const MAX_TOOL_OUTPUT_BYTES = 32 * 1024 * 1024;

interface ActiveRequest {
	readonly workDir: string;
	readonly processes: Set<ChildProcess>;
	readonly transcribeCts: CancellationTokenSource;
	audioPcmPath?: string;
	cancelled: boolean;
}

interface ToolRunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** `Duration: HH:MM:SS.ms` from an ffmpeg stderr banner; undefined when absent (`N/A`). */
function parseFfmpegDurationSec(stderr: string): number | undefined {
	const match = /Duration:\s*(?<h>\d+):(?<m>\d+):(?<s>\d+(?:\.\d+)?)/.exec(stderr);
	return match?.groups
		? Number(match.groups.h) * 3600 + Number(match.groups.m) * 60 + Number(match.groups.s)
		: undefined;
}

export class VibeVideoMainService extends Disposable {

	private readonly _onToolsDownloadProgress = this._register(new Emitter<VideoToolsDownloadProgress>());
	readonly onToolsDownloadProgress: Event<VideoToolsDownloadProgress> = this._onToolsDownloadProgress.event;

	private readonly _onAnalysisProgress = this._register(new Emitter<VideoAnalysisProgress>());
	readonly onAnalysisProgress: Event<VideoAnalysisProgress> = this._onAnalysisProgress.event;

	private readonly archive: VideoToolsArchive | undefined;
	private activeToolsDownload: Promise<void> | undefined;
	private readonly activeRequests = new Map<string, ActiveRequest>();

	constructor(
		private readonly logService: ILogService,
		private readonly environmentMainService: IEnvironmentMainService,
		private readonly configurationService: IConfigurationService,
		private readonly voiceService: VibeVoiceMainService,
	) {
		super();
		this.archive = videoToolsArchiveForPlatform(process.platform, process.arch);
	}

	override dispose(): void {
		for (const requestId of [...this.activeRequests.keys()]) {
			this.cancel(requestId);
		}
		super.dispose();
	}

	// ── Tools store ──────────────────────────────────────────────────────────

	private toolsRoot(): string {
		const configured = this.configurationService.getValue<string>(VIDEO_TOOLS_PATH_KEY);
		if (typeof configured === 'string' && configured.trim()) {
			return configured.trim();
		}
		return join(this.environmentMainService.userDataPath, 'video-tools');
	}

	private toolPaths(): { readonly ffmpeg: string; readonly ytDlp: string } | undefined {
		return this.archive ? resolveVideoToolPaths(this.toolsRoot(), this.archive) : undefined;
	}

	private areToolsInstalled(): boolean {
		const paths = this.toolPaths();
		return !!paths && existsSync(paths.ffmpeg) && existsSync(paths.ytDlp);
	}

	getToolsState(): VideoToolsState {
		if (!this.archive) {
			// Unsupported platform (e.g. linux-arm64) — surfaces as permanently 'missing'
			// with zero bytes; the renderer facade reports the feature unavailable instead.
			return { state: 'missing', downloadBytes: 0 };
		}
		if (this.activeToolsDownload) {
			return { state: 'downloading', downloadBytes: this.archive.sizeBytes };
		}
		return this.areToolsInstalled()
			? { state: 'ready', downloadBytes: 0 }
			: { state: 'missing', downloadBytes: this.archive.sizeBytes };
	}

	/** Download, verify and unpack the platform tools archive (deduped while running). */
	ensureTools(): Promise<void> {
		if (this.activeToolsDownload) {
			return this.activeToolsDownload;
		}
		const task = this.doEnsureTools().finally(() => { this.activeToolsDownload = undefined; });
		this.activeToolsDownload = task;
		return task;
	}

	private async doEnsureTools(): Promise<void> {
		const archive = this.archive;
		if (!archive) {
			throw new Error('Video tools are not available for this platform');
		}
		if (this.areToolsInstalled()) {
			return;
		}
		const root = this.toolsRoot();
		const versionDir = join(root, VIDEO_TOOLS_DIR);
		const zipPath = join(root, '.download-video-tools.zip');
		let receivedBytes = 0;
		let lastEmitted = 0;
		const emitProgress = (done: boolean, error?: string) => {
			this._onToolsDownloadProgress.fire({ receivedBytes, totalBytes: archive.sizeBytes, done, error });
		};
		try {
			await fsPromises.mkdir(versionDir, { recursive: true });
			this.logService.info(`[vibeVideo] downloading tools (${archive.sizeBytes} bytes)`);
			try {
				await downloadWithSha256(archive.url, zipPath, archive.sha256, chunkBytes => {
					receivedBytes += chunkBytes;
					if (receivedBytes - lastEmitted >= PROGRESS_EMIT_STEP_BYTES) {
						lastEmitted = receivedBytes;
						emitProgress(false);
					}
				});
				const { extract } = await import('../../../../../base/node/zip.js');
				await extract(zipPath, versionDir, {}, CancellationToken.None);
			} finally {
				await fsPromises.rm(zipPath, { force: true });
			}
			const paths = resolveVideoToolPaths(root, archive);
			if (!existsSync(paths.ffmpeg) || !existsSync(paths.ytDlp)) {
				throw new Error('Tools archive did not contain the expected files');
			}
			if (process.platform !== 'win32') {
				// zip.ts extract does not restore unix modes — the binaries must be executable.
				await fsPromises.chmod(paths.ffmpeg, 0o755);
				await fsPromises.chmod(paths.ytDlp, 0o755);
			}
			receivedBytes = archive.sizeBytes;
			emitProgress(true);
			this.logService.info('[vibeVideo] tools ready');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logService.error(`[vibeVideo] tools download failed: ${message}`);
			emitProgress(true, message);
			throw error;
		}
	}

	/**
	 * Self-update the standalone yt-dlp binary (YouTube regularly breaks old extractors).
	 * Returns the tool's own report line. The SHA256 of the catalog covers only the first
	 * install; an updated binary is trusted the same way the updater endpoint is.
	 */
	async updateYtDlp(): Promise<string> {
		const paths = this.toolPaths();
		if (!paths || !this.areToolsInstalled()) {
			throw new Error('Video tools are not installed');
		}
		const result = await this.runDetachedTool(paths.ytDlp, ['-U']);
		const output = `${result.stdout}\n${result.stderr}`.trim();
		if (result.code !== 0) {
			throw new Error(output.split('\n').slice(-3).join('\n') || `yt-dlp -U exited with ${result.code}`);
		}
		this.logService.info(`[vibeVideo] yt-dlp update: ${output.split('\n').pop()}`);
		return output.split('\n').pop() ?? '';
	}

	// ── Pipeline ─────────────────────────────────────────────────────────────

	async analyze(options: VideoAnalyzeOptions): Promise<VideoAnalysisResult> {
		const paths = this.toolPaths();
		if (!paths || !this.areToolsInstalled()) {
			throw new Error('Video tools are not installed');
		}
		const { requestId } = options;
		const input = options.input.trim();
		const workDir = join(tmpdir(), 'vibeide-watch', requestId);
		const entry: ActiveRequest = { workDir, processes: new Set(), transcribeCts: new CancellationTokenSource(), cancelled: false };
		this.activeRequests.set(requestId, entry);
		try {
			await fsPromises.mkdir(join(workDir, 'frames'), { recursive: true });
			const remote = isRemoteVideoInput(input);
			if (!remote && !existsSync(input)) {
				throw new Error(`Файл не найден: ${input}`);
			}

			let title: string | undefined;
			let durationSec: number | undefined;
			let videoPath: string;
			let transcriptSrt: string | undefined;

			if (remote) {
				this.emitStage(requestId, 'probe');
				const probe = await this.probeRemote(entry, paths.ytDlp, input);
				title = probe.title;
				durationSec = probe.durationSec;

				this.emitStage(requestId, 'subtitles');
				transcriptSrt = await this.fetchSubtitles(entry, paths.ytDlp, input, workDir);

				// Probe-first: positive video evidence wins; the extension hint only decides
				// when the probe is inconclusive (generic extractor without vcodec info).
				if (probe.audioOnly || (!probe.hasVideo && classifyWatchInput(input) === 'audio')) {
					return await this.finishAudioOnly(entry, paths, requestId, workDir, { title, durationSec, transcriptSrt }, { remoteUrl: input });
				}

				this.emitStage(requestId, 'download');
				const height = clampVideoFrameHeight(this.configurationService.getValue<number>(VIDEO_FRAME_HEIGHT_KEY));
				videoPath = await this.downloadMedia(entry, paths, input, workDir, requestId, `bv*[height<=${height}]+ba/b[height<=${height}]`, 'video');
			} else {
				title = basename(input);
				const probe = await this.probeLocalMedia(entry, paths.ffmpeg, input);
				durationSec = probe.durationSec;
				if (!probe.hasVideoStream) {
					return await this.finishAudioOnly(entry, paths, requestId, workDir, { title, durationSec }, { localPath: input });
				}
				videoPath = input;
			}

			this.emitStage(requestId, 'frames');
			const extraction = await this.extractFrames(entry, paths.ffmpeg, videoPath, workDir);
			durationSec ??= extraction.durationSec;

			let audioPcmPath: string | undefined;
			if (!transcriptSrt) {
				this.emitStage(requestId, 'audio');
				audioPcmPath = await this.extractAudioPcm(entry, paths.ffmpeg, videoPath, workDir);
				entry.audioPcmPath = audioPcmPath;
			}

			return { requestId, kind: 'video', title, durationSec, frames: extraction.frames, transcriptSrt, audioPcmPath, workDir };
		} catch (error) {
			await this.removeWorkDir(requestId, entry);
			this.activeRequests.delete(requestId);
			if (entry.cancelled) {
				throw new Error('Разбор видео отменён');
			}
			throw error;
		}
	}

	/**
	 * Tail of the pipeline for audio-only inputs — no frame stage. Subtitles in hand mean
	 * nothing needs downloading at all; otherwise the audio track (remote → yt-dlp bestaudio,
	 * local — the input itself) becomes PCM16 for the renderer-driven STT fallback.
	 */
	private async finishAudioOnly(
		entry: ActiveRequest,
		paths: { readonly ffmpeg: string; readonly ytDlp: string },
		requestId: string,
		workDir: string,
		meta: { readonly title?: string; readonly durationSec?: number; readonly transcriptSrt?: string },
		source: { readonly remoteUrl: string } | { readonly localPath: string },
	): Promise<VideoAnalysisResult> {
		let audioPcmPath: string | undefined;
		if (!meta.transcriptSrt) {
			let mediaPath: string;
			// eslint-disable-next-line local/code-no-in-operator -- discriminated-union narrowing; `in` narrows the type, hasOwn does not
			if ('remoteUrl' in source) {
				this.emitStage(requestId, 'download');
				mediaPath = await this.downloadMedia(entry, paths, source.remoteUrl, workDir, requestId, 'ba/b', 'media');
			} else {
				mediaPath = source.localPath;
			}
			this.emitStage(requestId, 'audio');
			audioPcmPath = await this.extractAudioPcm(entry, paths.ffmpeg, mediaPath, workDir);
			if (!audioPcmPath) {
				throw new Error('В файле не найдено аудиодорожки');
			}
			entry.audioPcmPath = audioPcmPath;
		}
		return { requestId, kind: 'audio', title: meta.title, durationSec: meta.durationSec, frames: [], transcriptSrt: meta.transcriptSrt, audioPcmPath, workDir };
	}

	/**
	 * STT fallback over the PCM extracted by `analyze` (same requestId). The path comes from
	 * our own map, not from the caller — the channel cannot be used to read arbitrary files.
	 */
	async transcribe(requestId: string, profileId: VoiceProfileId): Promise<VideoTranscriptSegment[]> {
		const entry = this.activeRequests.get(requestId);
		if (!entry?.audioPcmPath) {
			throw new Error('No extracted audio for this request');
		}
		const pcm = await fsPromises.readFile(entry.audioPcmPath);
		return this.voiceService.transcribePcm16(
			pcm,
			profileId,
			(processedSec, totalSec) => {
				this._onAnalysisProgress.fire({ requestId, stage: 'audio', percent: totalSec > 0 ? Math.min(100, Math.round(processedSec / totalSec * 100)) : undefined });
			},
			entry.transcribeCts.token,
		);
	}

	cancel(requestId: string): void {
		const entry = this.activeRequests.get(requestId);
		if (!entry) {
			return;
		}
		entry.cancelled = true;
		entry.transcribeCts.cancel();
		for (const child of [...entry.processes]) {
			child.kill();
		}
	}

	/** Renderer calls this once the frames are consumed (attachments built). */
	async cleanup(requestId: string): Promise<void> {
		const entry = this.activeRequests.get(requestId);
		if (!entry) {
			return;
		}
		this.activeRequests.delete(requestId);
		entry.transcribeCts.dispose();
		await this.removeWorkDir(requestId, entry);
	}

	private async removeWorkDir(requestId: string, entry: ActiveRequest): Promise<void> {
		try {
			await fsPromises.rm(entry.workDir, { recursive: true, force: true });
		} catch (error) {
			this.logService.warn(`[vibeVideo] failed to clean ${entry.workDir}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private emitStage(requestId: string, stage: VideoAnalysisStage, percent?: number): void {
		this._onAnalysisProgress.fire({ requestId, stage, percent });
	}

	// ── Pipeline stages ──────────────────────────────────────────────────────

	private async probeRemote(entry: ActiveRequest, ytDlp: string, url: string): Promise<{ title?: string; durationSec?: number; audioOnly: boolean; hasVideo: boolean }> {
		const result = await this.runTool(entry, ytDlp, ['--dump-single-json', '--no-playlist', '--skip-download', url]);
		if (result.code !== 0) {
			throw new Error(this.describeYtDlpFailure(result));
		}
		try {
			const meta = JSON.parse(result.stdout) as { title?: unknown; duration?: unknown; formats?: unknown };
			// `audioOnly` — every described format explicitly carries no video codec.
			// `hasVideo` — at least one format positively names a video codec; the generic
			// extractor often reports no vcodec at all, leaving both false (inconclusive) —
			// the caller then falls back to the file-extension hint.
			const formats = (Array.isArray(meta.formats) ? meta.formats as readonly { vcodec?: unknown }[] : []).filter(f => !!f && typeof f === 'object');
			const audioOnly = formats.length > 0 && formats.every(f => f.vcodec === 'none');
			const hasVideo = formats.some(f => typeof f.vcodec === 'string' && f.vcodec !== 'none');
			return {
				title: typeof meta.title === 'string' ? meta.title : undefined,
				durationSec: typeof meta.duration === 'number' && Number.isFinite(meta.duration) ? meta.duration : undefined,
				audioOnly,
				hasVideo,
			};
		} catch {
			return { audioOnly: false, hasVideo: false };
		}
	}

	/**
	 * `ffmpeg -i` stream-layout probe for a local file — ffmpeg exits non-zero without an
	 * output target, only the stderr banner matters. Cover art inside audio files shows up
	 * as a `Video: mjpeg … (attached pic)` stream and must not count as video.
	 */
	private async probeLocalMedia(entry: ActiveRequest, ffmpeg: string, mediaPath: string): Promise<{ hasVideoStream: boolean; durationSec?: number }> {
		const result = await this.runTool(entry, ffmpeg, ['-hide_banner', '-i', mediaPath]);
		const streams = result.stderr.split('\n').filter(line => /Stream #\d+:\d+/.test(line));
		if (streams.length === 0) {
			// Unreadable input (corrupt container, not a media file): surface ffmpeg's own
			// reason instead of routing to a branch that would blame a missing audio track.
			const tail = result.stderr.trim().split('\n').pop() ?? '';
			throw new Error(`ffmpeg: ${tail || `exit code ${result.code}`}`);
		}
		const hasVideoStream = streams.some(line => /: Video: /.test(line) && !line.includes('attached pic'));
		return { hasVideoStream, durationSec: parseFfmpegDurationSec(result.stderr) };
	}

	private async fetchSubtitles(entry: ActiveRequest, ytDlp: string, url: string, workDir: string): Promise<string | undefined> {
		const languages = normalizeVideoSubtitleLanguages(this.configurationService.getValue<string>(VIDEO_SUBTITLE_LANGUAGES_KEY));
		const result = await this.runTool(entry, ytDlp, [
			'--write-subs', '--write-auto-subs',
			'--sub-langs', languages,
			'--skip-download', '--no-playlist',
			'--convert-subs', 'srt',
			'-o', join(workDir, 'subs.%(ext)s'),
			url,
		]);
		if (result.code !== 0) {
			// Subtitles are best-effort: a failure here must not kill the whole pipeline.
			this.logService.warn(`[vibeVideo] subtitles fetch failed: ${result.stderr.split('\n').pop()}`);
			return undefined;
		}
		const names = (await fsPromises.readdir(workDir)).filter(n => n.startsWith('subs.') && n.endsWith('.srt'));
		if (names.length === 0) {
			return undefined;
		}
		// Prefer the configured language order (`subs.ru.srt` over `subs.en.srt`).
		const ranked = languages.split(',');
		names.sort((a, b) => {
			const rank = (name: string) => {
				const lang = name.slice('subs.'.length, -'.srt'.length).toLowerCase();
				const index = ranked.findIndex(l => lang === l || lang.startsWith(`${l}-`));
				return index === -1 ? ranked.length : index;
			};
			return rank(a) - rank(b);
		});
		const buffer = await fsPromises.readFile(join(workDir, names[0]));
		return buffer.subarray(0, MAX_TRANSCRIPT_BYTES).toString('utf8');
	}

	/**
	 * yt-dlp download with `[download] N%` progress relayed to the renderer. `formatSpec` is
	 * the `-f` selector (video branch: `bv*[height<=N]+ba/b[height<=N]`, audio-only: `ba/b`);
	 * `baseName` keeps the branches' files apart in the shared work dir.
	 * `<baseName>.%(ext)s`, never a hard-coded container: when the best streams are webm,
	 * yt-dlp ignores a forced `.mp4` name and produces `video.mp4.webm` (verified
	 * 2026-07-17) — the real file is found by prefix below, ffmpeg reads any container.
	 */
	private async downloadMedia(entry: ActiveRequest, paths: { ffmpeg: string; ytDlp: string }, url: string, workDir: string, requestId: string, formatSpec: string, baseName: string): Promise<string> {
		const result = await this.runTool(entry, paths.ytDlp, [
			'-f', formatSpec,
			'--no-playlist',
			'--ffmpeg-location', paths.ffmpeg,
			'-o', join(workDir, `${baseName}.%(ext)s`),
			url,
		], line => {
			const match = /\[download\]\s+(?<percent>\d+(?:\.\d+)?)%/.exec(line);
			if (match?.groups) {
				this.emitStage(requestId, 'download', Math.round(Number(match.groups.percent)));
			}
		});
		if (result.code !== 0) {
			throw new Error(this.describeYtDlpFailure(result));
		}
		const names = (await fsPromises.readdir(workDir)).filter(n => n.startsWith(`${baseName}.`));
		if (names.length === 0) {
			throw new Error('yt-dlp не сохранил медиафайл');
		}
		return join(workDir, names[0]);
	}

	private describeYtDlpFailure(result: ToolRunResult): string {
		const tail = result.stderr.trim().split('\n').filter(l => l.includes('ERROR')).pop()
			?? result.stderr.trim().split('\n').pop() ?? '';
		return `yt-dlp: ${tail || `exit code ${result.code}`}`;
	}

	private async extractFrames(entry: ActiveRequest, ffmpeg: string, videoPath: string, workDir: string): Promise<{ frames: VideoFrameInfo[]; durationSec?: number }> {
		const framesDir = join(workDir, 'frames');
		const height = clampVideoFrameHeight(this.configurationService.getValue<number>(VIDEO_FRAME_HEIGHT_KEY));
		const maxFrames = clampVideoMaxFrames(this.configurationService.getValue<number>(VIDEO_MAX_FRAMES_KEY));
		const configuredThreshold = clampVideoSceneThreshold(this.configurationService.getValue<number>(VIDEO_SCENE_THRESHOLD_KEY));

		let pass = await this.runFramePass(entry, ffmpeg, videoPath, framesDir, height, configuredThreshold);
		if (pass.frames.length < MIN_USEFUL_FRAMES && configuredThreshold > RETRY_SCENE_THRESHOLD) {
			// Single-shot videos (static screencasts, talking heads) can yield zero scene
			// changes at the default threshold — retry once with the low one (frame 0 is
			// always captured via eq(n,0), so even the retry can't return empty).
			this.logService.info(`[vibeVideo] only ${pass.frames.length} frames at threshold ${configuredThreshold} — retrying at ${RETRY_SCENE_THRESHOLD}`);
			await this.clearDir(framesDir);
			pass = await this.runFramePass(entry, ffmpeg, videoPath, framesDir, height, RETRY_SCENE_THRESHOLD);
		}

		const kept = selectEvenlySpreadFrames(pass.frames, maxFrames);
		if (kept.length < pass.frames.length) {
			const keptPaths = new Set(kept.map(f => f.path));
			await Promise.all(pass.frames.filter(f => !keptPaths.has(f.path)).map(f => fsPromises.rm(f.path, { force: true })));
		}
		return { frames: kept, durationSec: pass.durationSec };
	}

	private async runFramePass(entry: ActiveRequest, ffmpeg: string, videoPath: string, framesDir: string, height: number, threshold: number): Promise<{ frames: VideoFrameInfo[]; durationSec?: number }> {
		// Frame 0 is always selected as an anchor; scene changes above the threshold add the
		// rest. showinfo (after select) logs pts_time + dimensions per KEPT frame, which is
		// the timecode binding. `-fps_mode vfr` keeps one image per selected frame.
		const filter = `select='eq(n,0)+gt(scene,${threshold})',scale=-2:'min(${height},ih)',showinfo`;
		const result = await this.runTool(entry, ffmpeg, [
			'-hide_banner',
			'-i', videoPath,
			'-vf', filter,
			'-fps_mode', 'vfr',
			'-q:v', '3',
			join(framesDir, 'frame_%04d.jpg'),
		]);
		if (result.code !== 0) {
			const tail = result.stderr.trim().split('\n').pop() ?? '';
			throw new Error(`ffmpeg: ${tail || `exit code ${result.code}`}`);
		}
		const frames: VideoFrameInfo[] = [];
		// showinfo line: `[Parsed_showinfo_2 @ 0x...] n:   4 ... pts_time:13.2 ... s:1280x720 ...`
		// The size separator differs across ffmpeg majors: 6.x prints `s:WxH`, 8.x `s=WxH` —
		// accept both (verified live: b6.0 static build produced zero parsed frames with `=` only).
		const lineRe = /n:\s*(?<order>\d+).*?pts_time:(?<pts>[\d.]+).*?s[:=](?<width>\d+)x(?<height>\d+)/g;
		for (const match of result.stderr.matchAll(lineRe)) {
			const groups = match.groups!;
			const path = join(framesDir, `frame_${String(Number(groups.order) + 1).padStart(4, '0')}.jpg`);
			if (!existsSync(path)) {
				continue;
			}
			const stat = await fsPromises.stat(path);
			frames.push({
				path,
				timeSec: Number(groups.pts),
				width: Number(groups.width),
				height: Number(groups.height),
				sizeBytes: stat.size,
			});
		}
		frames.sort((a, b) => a.timeSec - b.timeSec);
		return { frames, durationSec: parseFfmpegDurationSec(result.stderr) };
	}

	private async clearDir(dir: string): Promise<void> {
		for (const name of await fsPromises.readdir(dir)) {
			await fsPromises.rm(join(dir, name), { force: true });
		}
	}

	/** Extract 16 kHz mono PCM16 audio for the STT fallback; undefined when there is no audio track. */
	private async extractAudioPcm(entry: ActiveRequest, ffmpeg: string, videoPath: string, workDir: string): Promise<string | undefined> {
		const pcmPath = join(workDir, 'audio.pcm');
		const result = await this.runTool(entry, ffmpeg, [
			'-hide_banner',
			'-i', videoPath,
			'-vn',
			'-f', 's16le', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
			pcmPath,
		]);
		if (result.code !== 0 || !existsSync(pcmPath)) {
			this.logService.info('[vibeVideo] no audio track extracted (video without sound?)');
			return undefined;
		}
		const stat = await fsPromises.stat(pcmPath);
		return stat.size > 0 ? pcmPath : undefined;
	}

	// ── Child processes ──────────────────────────────────────────────────────

	private runTool(entry: ActiveRequest, command: string, args: string[], onStdoutLine?: (line: string) => void): Promise<ToolRunResult> {
		if (entry.cancelled) {
			return Promise.reject(new Error('Разбор видео отменён'));
		}
		return new Promise<ToolRunResult>((resolve, reject) => {
			const child = spawn(command, args, { windowsHide: true });
			entry.processes.add(child);
			let stdout = '';
			let stderr = '';
			let lineTail = '';
			child.stdout.on('data', (chunk: Buffer) => {
				if (stdout.length < MAX_TOOL_OUTPUT_BYTES) {
					stdout += chunk.toString('utf8');
				}
				if (onStdoutLine) {
					// yt-dlp rewrites its progress line with `\r` — split on both terminators.
					const lines = (lineTail + chunk.toString('utf8')).split(/[\r\n]/);
					lineTail = lines.pop() ?? '';
					for (const line of lines) {
						onStdoutLine(line);
					}
				}
			});
			child.stderr.on('data', (chunk: Buffer) => {
				if (stderr.length < MAX_TOOL_OUTPUT_BYTES) {
					stderr += chunk.toString('utf8');
				}
			});
			child.on('error', error => {
				entry.processes.delete(child);
				reject(error);
			});
			child.on('close', code => {
				entry.processes.delete(child);
				if (onStdoutLine && lineTail) {
					onStdoutLine(lineTail);
				}
				resolve({ code: code ?? -1, stdout, stderr });
			});
		});
	}

	/** One-off tool run outside any analyze request (yt-dlp self-update). */
	private runDetachedTool(command: string, args: string[]): Promise<ToolRunResult> {
		const detached: ActiveRequest = { workDir: '', processes: new Set(), transcribeCts: new CancellationTokenSource(), cancelled: false };
		return this.runTool(detached, command, args).finally(() => detached.transcribeCts.dispose());
	}
}
