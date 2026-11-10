/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Кадры видео: HDR → обычный цвет, таймкод на кадре и раскладка кадров по листам
 *
 * Чистый модуль: только строки и числа — ни ffmpeg, ни файлов, ни окружения
 * Главный процесс собирает из этого фильтры и команды, тесты проверяют результат без запуска инструментов
 */

/** Переносы HDR, которые ffmpeg называет в строке потока: PQ (HDR10) и HLG */
const HDR_TRANSFER_MARKERS: readonly string[] = ['smpte2084', 'arib-std-b67'];

/** Приведение HDR к обычному цвету: линейный свет → тонмаппинг Хабеля → bt709; без него HDR-кадры выходят блёклыми */
export const HDR_TO_SDR_FILTER = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** До скольких кадров кладём на один лист: больше — модель уже не разбирает мелкие врезки */
export const SHEET_MAX_FRAMES = 12;

/** Поле вокруг сетки листа и отступ между ячейками в пикселях: те же числа стоят в команде `tile` */
export const SHEET_TILE_MARGIN = 4;
export const SHEET_TILE_PADDING = 4;

/**
 * Строка потока из баннера `ffmpeg -i` описывает HDR?
 *
 * HDR виден по переносу: `smpte2084` (PQ, он же HDR10) или `arib-std-b67` (HLG)
 * Обложка аудиофайла — тоже «видео» в баннере, но HDR в ней не бывает: `attached pic` отсекаем
 */
export function isHdrStreamLine(line: string): boolean {
	if (line.includes('attached pic')) {
		return false;
	}
	return HDR_TRANSFER_MARKERS.some(marker => line.includes(marker));
}

/**
 * Имена фильтров из вывода `ffmpeg -filters`
 *
 * Знаков свойств перед именем в ffmpeg 6 три (`TS. colorspace`), в ffmpeg 8 — два (`.. tile`):
 * Разбор под одну версию молча выключил бы HDR и листы на другой
 */
export function parseFfmpegFilterNames(output: string): Set<string> {
	const names = new Set<string>();
	for (const line of output.split('\n')) {
		const match = /^\s*[TSCA.|]{2,3}\s+(?<name>[A-Za-z0-9_]+)\s+\S+->\S+/.exec(line);
		if (match?.groups) {
			names.add(match.groups.name);
		}
	}
	return names;
}

/** Что просит вызвавший: порог сцен, высоту кадра, тонмаппинг и шрифт для таймкода */
export interface FramePassFilterOptions {
	readonly threshold: number;
	readonly height: number;
	/** HDR найден и сборка ffmpeg умеет его тонмаппить */
	readonly tonemap: boolean;
	/** Путь к шрифту; без него кадр остаётся без подписи */
	readonly timecodeFont?: string;
}

/**
 * Фильтр одного прохода нарезки кадров
 *
 * Порядок важен: сцены отбираются на исходных кадрах, цвет приводится до масштабирования,
 * а таймкод рисуется уже на уменьшенном кадре — иначе `drawtext` считал бы координаты по исходному размеру
 */
export function buildFramePassFilter(options: FramePassFilterOptions): string {
	const parts = [`select='eq(n,0)+gt(scene,${options.threshold})'`];
	if (options.tonemap) {
		parts.push(HDR_TO_SDR_FILTER);
	}
	parts.push(`scale=-2:'min(${options.height},ih)'`);
	if (options.timecodeFont) {
		parts.push(drawtextFilter(options.timecodeFont));
	}
	parts.push('showinfo');
	return parts.join(',');
}

/** Таймкод в правом нижнем углу: белым по полупрозрачной подложке, чтобы читался на светлом и на тёмном */
function drawtextFilter(fontFile: string): string {
	return `drawtext=fontfile=${escapeFilterPath(fontFile)}:text='%{pts\\:hms}':x=w-tw-12:y=h-th-12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`;
}

/**
 * Путь к шрифту для графа фильтров ffmpeg
 *
 * Обратный слэш меняем на прямой: так путь Windows понимает ffmpeg, а экранировать каждый разделитель не нужно
 * Двоеточие разделяет опции фильтра, кавычка открывает строку — оба экранируются
 */
function escapeFilterPath(path: string): string {
	return path
		.replace(/\\/g, '/')
		.replace(/:/g, '\\:')
		.replace(/'/g, "\\'");
}

/**
 * Сетки листов для `count` кадров
 *
 * Колонок — min(4, ⌈√count⌉): сетка выходит близкой к квадрату, но не шире четырёх колонок
 * Строк — ⌈count / cols⌉, ровно столько, сколько нужно кадрам этого листа
 * На лист — не больше `maxPerSheet` кадров, последний лист забирает остаток
 * Пример: 5 → 3x2, 12 → 4x3, 13 → 4x3 и 1x1
 */
export function sheetGrid(count: number, maxPerSheet = SHEET_MAX_FRAMES): { cols: number; rows: number }[] {
	const total = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
	const perSheet = Math.max(1, Math.floor(maxPerSheet));
	const grids: { cols: number; rows: number }[] = [];
	for (let remaining = total; remaining > 0; remaining -= perSheet) {
		const onSheet = Math.min(perSheet, remaining);
		const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(onSheet))));
		grids.push({ cols, rows: Math.ceil(onSheet / cols) });
	}
	return grids;
}

/** Где искать шрифт для таймкода: стандартные пути шрифтов платформы, первый существующий и берём */
export function timecodeFontCandidates(platform: 'darwin' | 'win32' | 'linux'): string[] {
	switch (platform) {
		case 'darwin':
			return ['/System/Library/Fonts/Helvetica.ttc', '/System/Library/Fonts/Supplemental/Arial.ttf'];
		case 'win32':
			return ['C:\\Windows\\Fonts\\arial.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf'];
		case 'linux':
			return ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf'];
		default:
			return [];
	}
}
