/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — shared contracts.
 *
 * Pure data shapes and the channel protocol. No node/browser/electron imports: the renderer
 * (electron-browser/video), the main-process pipeline (electron-main/video) and the React chat
 * all speak these types over IPC.
 *
 * Pipeline overview (see docs/knowledge/video/):
 *   /watch <url|path> in chat → main process: yt-dlp (video + subtitles) → ffmpeg scene
 *   detection (frames with pts timecodes) → renderer: frames become image attachments,
 *   transcript becomes text → one vision request to the chat model. Videos without
 *   subtitles fall back to the local STT worker (GigaAM offline batch decode).
 *   Audio-only inputs (podcast, mp3, voice message) skip the frame stage entirely:
 *   subtitles or the STT fallback produce a transcript, the chat request carries no
 *   images and needs no vision model (`VideoAnalysisResult.kind` = 'audio').
 */

export const VIBE_VIDEO_CHANNEL = 'vibeide-channel-video';

/** Pipeline stages surfaced to the user (progress notification labels are renderer-side). */
export type VideoAnalysisStage = 'probe' | 'subtitles' | 'download' | 'frames' | 'audio';

export type VideoToolsStateKind = 'ready' | 'missing' | 'downloading';

export interface VideoToolsState {
	readonly state: VideoToolsStateKind;
	/** Bytes to download when `state` is not `ready` (platform archive size). */
	readonly downloadBytes: number;
}

/** Download progress of the tools archive (yt-dlp + ffmpeg), pushed main → renderer. */
export interface VideoToolsDownloadProgress {
	readonly receivedBytes: number;
	readonly totalBytes: number;
	readonly done: boolean;
	readonly error?: string;
}

/** Coarse progress of one analyze request, pushed main → renderer while the pipeline runs. */
export interface VideoAnalysisProgress {
	readonly requestId: string;
	readonly stage: VideoAnalysisStage;
	/** 0..100 within the stage when measurable (video download, STT chunks); absent otherwise. */
	readonly percent?: number;
}

export interface VideoAnalyzeOptions {
	readonly requestId: string;
	/** http(s) URL (YouTube/Loom/direct media) or an absolute local file path. */
	readonly input: string;
}

/** One extracted frame on disk (JPEG), bound to its source timecode. */
export interface VideoFrameInfo {
	readonly path: string;
	readonly timeSec: number;
	readonly width: number;
	readonly height: number;
	readonly sizeBytes: number;
}

export type VideoTranscriptKind = 'subtitles' | 'stt' | 'none';

/**
 * What the pipeline actually processed. Probe-first: positive video evidence from the
 * ffmpeg/yt-dlp probes wins; the file-extension hint decides only when the remote probe
 * is inconclusive (generic extractor without vcodec info — e.g. a direct mp3 link).
 */
export type VideoAnalysisKind = 'video' | 'audio';

export interface VideoAnalysisResult {
	readonly requestId: string;
	/** 'audio' → `frames` is empty and the renderer sends a text-only (non-vision) request. */
	readonly kind: VideoAnalysisKind;
	readonly title?: string;
	readonly durationSec?: number;
	readonly frames: readonly VideoFrameInfo[];
	/** SRT text when subtitles were found; undefined otherwise (see `audioPcmPath`). */
	readonly transcriptSrt?: string;
	/**
	 * Present when there were no subtitles: 16 kHz mono PCM16 raw audio extracted for the
	 * STT fallback. The renderer decides whether to run it (STT models need user consent).
	 */
	readonly audioPcmPath?: string;
	/** Temp directory of this request — the renderer calls `cleanup` once frames are consumed. */
	readonly workDir: string;
}

/** One phrase of the STT fallback transcript (chunk-level timecodes). */
export interface VideoTranscriptSegment {
	readonly startSec: number;
	readonly endSec: number;
	readonly text: string;
}

/** `mm:ss` (or `h:mm:ss` past an hour) — timecode labels in prompts and frame filenames. */
export function formatVideoTimecode(totalSeconds: number): string {
	const clamped = Math.max(0, Math.floor(totalSeconds));
	const seconds = clamped % 60;
	const minutes = Math.floor(clamped / 60) % 60;
	const hours = Math.floor(clamped / 3600);
	const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	return hours > 0 ? `${hours}:${mmss}` : mmss;
}

/** Thin `frames` down to `maxCount` keeping the first frame and an even spread over time. */
export function selectEvenlySpreadFrames<T>(frames: readonly T[], maxCount: number): T[] {
	if (maxCount <= 0) {
		return [];
	}
	if (frames.length <= maxCount) {
		return [...frames];
	}
	if (maxCount === 1) {
		return [frames[0]];
	}
	const picked: T[] = [];
	const lastIndex = frames.length - 1;
	let previous = -1;
	for (let i = 0; i < maxCount; i++) {
		const index = Math.round(i * lastIndex / (maxCount - 1));
		if (index !== previous) {
			picked.push(frames[index]);
			previous = index;
		}
	}
	return picked;
}
