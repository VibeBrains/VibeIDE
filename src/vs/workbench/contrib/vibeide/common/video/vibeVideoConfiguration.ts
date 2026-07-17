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
		[VIDEO_SCENE_THRESHOLD_KEY]: {
			type: 'number',
			default: VIDEO_SCENE_THRESHOLD_DEFAULT,
			minimum: SCENE_THRESHOLD_MIN,
			maximum: SCENE_THRESHOLD_MAX,
			description: localize('vibeide.video.sceneThreshold', 'Порог смены сцены (0.05–0.9) для отбора кадров. Ниже — больше кадров (статичные скринкасты), выше — меньше (динамичный монтаж). Если кадров почти нет, пайплайн сам понижает порог и пробует ещё раз.'),
		},
		[VIDEO_MAX_FRAMES_KEY]: {
			type: 'number',
			default: VIDEO_MAX_FRAMES_DEFAULT,
			minimum: MAX_FRAMES_MIN,
			maximum: MAX_FRAMES_MAX,
			description: localize('vibeide.video.maxFrames', 'Максимум кадров, отправляемых модели за один разбор. Лишние кадры прореживаются равномерно по времени. Больше кадров — подробнее разбор, но дороже запрос.'),
		},
		[VIDEO_FRAME_HEIGHT_KEY]: {
			type: 'number',
			default: VIDEO_FRAME_HEIGHT_DEFAULT,
			minimum: FRAME_HEIGHT_MIN,
			maximum: FRAME_HEIGHT_MAX,
			description: localize('vibeide.video.frameHeight', 'Высота кадров в пикселях (240–1080), к которой даунскейлится видео перед отправкой модели. Выше — читаемее мелкий текст на экране, но тяжелее запрос.'),
		},
		[VIDEO_SUBTITLE_LANGUAGES_KEY]: {
			type: 'string',
			default: VIDEO_SUBTITLE_LANGUAGES_DEFAULT,
			description: localize('vibeide.video.subtitleLanguages', 'Языки субтитров через запятую (в порядке предпочтения) для скачивания с видео. Если субтитров нет, звук расшифровывается локальными моделями голосового ввода.'),
		},
	},
});
