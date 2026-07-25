/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Video analysis (/watch) — `vibeide.video.*` settings. Registered on module load; the module
 * is imported (side effect) from `browser/vibeide.contribution.ts` so the keys exist in the
 * Settings UI regardless of whether the desktop pipeline services are running.
 */

import { localize } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';

export const VIDEO_ENABLED_KEY = 'vibeide.video.enabled';
export const VIDEO_TOOLS_PATH_KEY = 'vibeide.video.toolsPath';
export const VIDEO_DETAIL_KEY = 'vibeide.video.detail';
export const VIDEO_SCENE_THRESHOLD_KEY = 'vibeide.video.sceneThreshold';
export const VIDEO_MAX_FRAMES_KEY = 'vibeide.video.maxFrames';
export const VIDEO_FRAME_HEIGHT_KEY = 'vibeide.video.frameHeight';
export const VIDEO_SUBTITLE_LANGUAGES_KEY = 'vibeide.video.subtitleLanguages';

export const VIDEO_SCENE_THRESHOLD_DEFAULT = 0.3;
export const VIDEO_MAX_FRAMES_DEFAULT = 48;
export const VIDEO_FRAME_HEIGHT_DEFAULT = 720;
export const VIDEO_SUBTITLE_LANGUAGES_DEFAULT = 'ru,en';

const SCENE_THRESHOLD_MIN = 0.05;
const SCENE_THRESHOLD_MAX = 0.9;
const MAX_FRAMES_MIN = 4;
const MAX_FRAMES_MAX = 150;
const FRAME_HEIGHT_MIN = 240;
const FRAME_HEIGHT_MAX = 1080;

export function clampVideoSceneThreshold(configured: unknown): number {
	const value = typeof configured === 'number' ? configured : NaN;
	if (!Number.isFinite(value)) {
		return VIDEO_SCENE_THRESHOLD_DEFAULT;
	}
	return Math.min(SCENE_THRESHOLD_MAX, Math.max(SCENE_THRESHOLD_MIN, value));
}

export function clampVideoMaxFrames(configured: unknown): number {
	const value = typeof configured === 'number' ? configured : NaN;
	if (!Number.isFinite(value)) {
		return VIDEO_MAX_FRAMES_DEFAULT;
	}
	return Math.min(MAX_FRAMES_MAX, Math.max(MAX_FRAMES_MIN, Math.round(value)));
}

export function clampVideoFrameHeight(configured: unknown): number {
	const value = typeof configured === 'number' ? configured : NaN;
	if (!Number.isFinite(value)) {
		return VIDEO_FRAME_HEIGHT_DEFAULT;
	}
	return Math.min(FRAME_HEIGHT_MAX, Math.max(FRAME_HEIGHT_MIN, Math.round(value)));
}

/**
 * Detail level of a /watch run — one word instead of three numbers. Presets sit ON TOP of the
 * individual knobs: a knob the user set explicitly still wins (see `resolveVideoTuning`), so the
 * preset is a starting point, not a cage.
 */
export type VideoDetailLevel = 'transcript' | 'efficient' | 'balanced' | 'token-burner';

export const VIDEO_DETAIL_DEFAULT: VideoDetailLevel = 'balanced';

/** Everything the pipeline needs to know about how thorough (and how expensive) this run should be. */
export interface VideoTuning {
	/** `false` → the video file is never downloaded; the run is transcript-only. */
	framesEnabled: boolean;
	sceneThreshold: number;
	maxFrames: number;
	frameHeight: number;
}

const VIDEO_DETAIL_PRESETS: Readonly<Record<VideoDetailLevel, VideoTuning>> = {
	// Cheapest possible: subtitles or speech recognition, zero frames, no video download at all.
	'transcript': { framesEnabled: false, sceneThreshold: VIDEO_SCENE_THRESHOLD_DEFAULT, maxFrames: MAX_FRAMES_MIN, frameHeight: 480 },
	// A quick look: few frames, only pronounced scene changes, small images.
	'efficient': { framesEnabled: true, sceneThreshold: 0.45, maxFrames: 16, frameHeight: 480 },
	// The historical defaults — what /watch did before presets existed.
	'balanced': { framesEnabled: true, sceneThreshold: VIDEO_SCENE_THRESHOLD_DEFAULT, maxFrames: VIDEO_MAX_FRAMES_DEFAULT, frameHeight: VIDEO_FRAME_HEIGHT_DEFAULT },
	// Everything the pipeline can give: the cap on frames, a low scene threshold, full-height images.
	'token-burner': { framesEnabled: true, sceneThreshold: 0.12, maxFrames: MAX_FRAMES_MAX, frameHeight: FRAME_HEIGHT_MAX },
};

export function normalizeVideoDetail(configured: unknown): VideoDetailLevel {
	return typeof configured === 'string' && configured in VIDEO_DETAIL_PRESETS
		? configured as VideoDetailLevel
		: VIDEO_DETAIL_DEFAULT;
}

/**
 * Resolve the tuning for one run: start from the preset, then let explicitly configured knobs
 * override it. `explicit` carries ONLY values the user actually set (from
 * `IConfigurationService.inspect`) — a knob left at its default must not shadow the preset,
 * otherwise picking `token-burner` would silently keep the default 48 frames.
 */
export function resolveVideoTuning(
	detail: unknown,
	explicit: { sceneThreshold?: unknown; maxFrames?: unknown; frameHeight?: unknown } = {},
): VideoTuning {
	const preset = VIDEO_DETAIL_PRESETS[normalizeVideoDetail(detail)];
	return {
		framesEnabled: preset.framesEnabled,
		sceneThreshold: explicit.sceneThreshold === undefined ? preset.sceneThreshold : clampVideoSceneThreshold(explicit.sceneThreshold),
		maxFrames: explicit.maxFrames === undefined ? preset.maxFrames : clampVideoMaxFrames(explicit.maxFrames),
		frameHeight: explicit.frameHeight === undefined ? preset.frameHeight : clampVideoFrameHeight(explicit.frameHeight),
	};
}

/** Normalize the comma-separated subtitle language list for `yt-dlp --sub-langs`. */
export function normalizeVideoSubtitleLanguages(configured: unknown): string {
	if (typeof configured !== 'string') {
		return VIDEO_SUBTITLE_LANGUAGES_DEFAULT;
	}
	const parts = configured.split(',').map(p => p.trim().toLowerCase()).filter(p => /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(p));
	return parts.length > 0 ? parts.join(',') : VIDEO_SUBTITLE_LANGUAGES_DEFAULT;
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		[VIDEO_ENABLED_KEY]: {
			type: 'boolean',
			default: true,
			description: localize('vibeide.video.enabled', 'Просмотр видео в чате (/watch): скачивание ролика, нарезка кадров по сменам сцен и разбор содержимого vision-моделью. Выключение убирает команду из чата.'),
		},
		[VIDEO_TOOLS_PATH_KEY]: {
			type: 'string',
			default: '',
			description: localize('vibeide.video.toolsPath', 'Каталог с инструментами видео-пайплайна (yt-dlp, ffmpeg). Пустая строка — стандартное расположение в данных пользователя. Для офлайн-переноса: скачайте инструменты на машине с интернетом и укажите путь к скопированному каталогу здесь.'),
		},
		[VIDEO_DETAIL_KEY]: {
			type: 'string',
			enum: ['transcript', 'efficient', 'balanced', 'token-burner'],
			default: VIDEO_DETAIL_DEFAULT,
			enumDescriptions: [
				localize('vibeide.video.detail.transcript', 'Только транскрипт: видео не скачивается вовсе, разбирается речь. Самый дешёвый и быстрый режим — для подкастов, созвонов и лекций «на слух».'),
				localize('vibeide.video.detail.efficient', 'Экономно: немного кадров и только на заметных сменах сцен. Понять, о чём ролик, не потратив лишнего.'),
				localize('vibeide.video.detail.balanced', 'Сбалансированно: разумное число кадров при читаемом размере. Подходит для большинства роликов.'),
				localize('vibeide.video.detail.tokenBurner', 'Максимум подробностей: предельное число кадров в полном размере. Для демо и скринкастов, где важна каждая мелочь на экране. Запрос выходит заметно дороже.'),
			],
			description: localize('vibeide.video.detail', 'Насколько подробно разбирать видео. Пресет задаёт сразу порог смены сцены, число кадров и их размер. Любую из этих настроек можно задать отдельно — заданная вручную всегда важнее пресета.'),
		},
		[VIDEO_SCENE_THRESHOLD_KEY]: {
			type: 'number',
			default: VIDEO_SCENE_THRESHOLD_DEFAULT,
			minimum: SCENE_THRESHOLD_MIN,
			maximum: SCENE_THRESHOLD_MAX,
			description: localize('vibeide.video.sceneThreshold', 'Порог смены сцены (0.05–0.9) для отбора кадров. Ниже — больше кадров (статичные скринкасты), выше — меньше (динамичный монтаж). Если кадров почти нет, пайплайн сам понижает порог и пробует ещё раз. Заданное здесь значение перекрывает пресет «Подробность разбора».'),
		},
		[VIDEO_MAX_FRAMES_KEY]: {
			type: 'number',
			default: VIDEO_MAX_FRAMES_DEFAULT,
			minimum: MAX_FRAMES_MIN,
			maximum: MAX_FRAMES_MAX,
			description: localize('vibeide.video.maxFrames', 'Максимум кадров, отправляемых модели за один разбор. Лишние кадры прореживаются равномерно по времени. Больше кадров — подробнее разбор, но дороже запрос. Заданное здесь значение перекрывает пресет «Подробность разбора».'),
		},
		[VIDEO_FRAME_HEIGHT_KEY]: {
			type: 'number',
			default: VIDEO_FRAME_HEIGHT_DEFAULT,
			minimum: FRAME_HEIGHT_MIN,
			maximum: FRAME_HEIGHT_MAX,
			description: localize('vibeide.video.frameHeight', 'Высота кадров в пикселях (240–1080), к которой даунскейлится видео перед отправкой модели. Выше — читаемее мелкий текст на экране, но тяжелее запрос. Заданное здесь значение перекрывает пресет «Подробность разбора».'),
		},
		[VIDEO_SUBTITLE_LANGUAGES_KEY]: {
			type: 'string',
			default: VIDEO_SUBTITLE_LANGUAGES_DEFAULT,
			description: localize('vibeide.video.subtitleLanguages', 'Языки субтитров через запятую (в порядке предпочтения) для скачивания с видео. Если субтитров нет, звук расшифровывается локальными моделями голосового ввода.'),
		},
	},
});
