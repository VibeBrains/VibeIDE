/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — tool binary catalog and path resolution. Pure module (no fs/node):
 * the main process does the actual disk checks and downloads; unit tests live in
 * `test/common/video/`.
 *
 * yt-dlp and a static ffmpeg build are NOT bundled with the IDE: they are downloaded on first
 * use from our own GitHub release mirror (tag `video-tools-v1` on the product repo), the same
 * scheme as the STT models (`stt-models-v1`, see `common/voice/vibeVoiceModels.ts`). Runtime
 * download keeps the distribution small and sidesteps packaging/signing of a GPL ffmpeg build.
 * Provenance: ffmpeg — eugeneware/ffmpeg-static b6.0 (FFmpeg 6.0, GPL); yt-dlp — official
 * standalone binaries 2026.07.04 (Unlicense). Licenses are recorded in the release notes.
 */

import { join } from '../../../../../base/common/path.js';

const MIRROR_BASE_URL = 'https://github.com/VibeBrains/VibeIDE/releases/download/video-tools-v1';

/**
 * Version subdirectory under the tools root. Bump together with the mirror tag: a new
 * release lands in a fresh directory, so an interrupted upgrade can never mix binaries.
 */
export const VIDEO_TOOLS_DIR = 'v1';

export type VideoToolsPlatformId = 'darwin-arm64' | 'darwin-x64' | 'linux-x64' | 'win32-x64';

/** One downloadable archive with both tool binaries for a platform. */
export interface VideoToolsArchive {
	readonly platform: VideoToolsPlatformId;
	readonly url: string;
	readonly sha256: string;
	/** Zip size in bytes — download progress totals and consent dialog labels. */
	readonly sizeBytes: number;
	/** Files (relative to the tools dir) that must exist for the tools to count as installed. */
	readonly files: readonly [ffmpeg: string, ytDlp: string];
}

const ARCHIVES: Record<VideoToolsPlatformId, VideoToolsArchive> = {
	'darwin-arm64': {
		platform: 'darwin-arm64',
		url: `${MIRROR_BASE_URL}/video-tools-darwin-arm64.zip`,
		sha256: '3564a332bfb420ba5062b8036545a44facc6cd14d2ed88d5ad3055a70bc72102',
		sizeBytes: 57077936,
		files: ['ffmpeg', 'yt-dlp'],
	},
	'darwin-x64': {
		platform: 'darwin-x64',
		url: `${MIRROR_BASE_URL}/video-tools-darwin-x64.zip`,
		sha256: 'f2e6cc50ca13fb925c66cbf482ca254554b3350a2b96b266df4777f5372f12ff',
		sizeBytes: 62974421,
		files: ['ffmpeg', 'yt-dlp'],
	},
	'linux-x64': {
		platform: 'linux-x64',
		url: `${MIRROR_BASE_URL}/video-tools-linux-x64.zip`,
		sha256: '68b534a294bbbf7ac40887c624fcc2f852a0ed9770aee4c00e06325f81e16fb6',
		sizeBytes: 68522553,
		files: ['ffmpeg', 'yt-dlp'],
	},
	'win32-x64': {
		platform: 'win32-x64',
		url: `${MIRROR_BASE_URL}/video-tools-win32-x64.zip`,
		sha256: '5d63386c567cd729ea3046515ca44e6cb3c9fd79dfe5151fe9501452716037a9',
		sizeBytes: 47000119,
		files: ['ffmpeg.exe', 'yt-dlp.exe'],
	},
};

/**
 * Map a node `process.platform`/`process.arch` pair to a catalog entry.
 * Rosetta note: `arch` is what the *process* runs as — an x64 build on Apple Silicon
 * correctly gets the x64 tools. Unsupported combos (e.g. linux-arm64) return undefined
 * and the feature reports itself unavailable instead of downloading a wrong binary.
 */
export function videoToolsArchiveForPlatform(platform: string, arch: string): VideoToolsArchive | undefined {
	if (platform === 'darwin') {
		return arch === 'arm64' ? ARCHIVES['darwin-arm64'] : arch === 'x64' ? ARCHIVES['darwin-x64'] : undefined;
	}
	if (platform === 'win32' && arch === 'x64') {
		return ARCHIVES['win32-x64'];
	}
	if (platform === 'linux' && arch === 'x64') {
		return ARCHIVES['linux-x64'];
	}
	return undefined;
}

/** Absolute paths of both binaries for a given tools root directory. */
export function resolveVideoToolPaths(toolsRoot: string, archive: VideoToolsArchive): { readonly ffmpeg: string; readonly ytDlp: string } {
	return {
		ffmpeg: join(toolsRoot, VIDEO_TOOLS_DIR, archive.files[0]),
		ytDlp: join(toolsRoot, VIDEO_TOOLS_DIR, archive.files[1]),
	};
}

/** True for inputs the pipeline treats as remote (yt-dlp); everything else is a local path. */
export function isRemoteVideoInput(input: string): boolean {
	return /^https?:\/\//i.test(input.trim());
}
