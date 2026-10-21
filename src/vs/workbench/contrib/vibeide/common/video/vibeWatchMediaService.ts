/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Движок просмотра записей: ссылка или файл → расшифровка и кадры
 *
 * Один движок, три входа:
 * - команда `/watch` в чате: кадры уходят картинками в сообщение (`IVibeVideoChatService` кладёт их в тред)
 * - инструмент модели `watch_media`: основной чат и роли получают текст, кадры в нём описаны
 * - инструмент `vibe_watch_media` MCP-сервера редактора: внешний агент получает текст и сами кадры картинками
 *
 * Движок не знает про чат: поэтому инструменту не нужен сервис чата, а он сам зависит от инструментов
 * (реализация — `electron-browser/video/vibeWatchMediaService.ts`, только десктоп)
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVibeVideoChatState } from './vibeVideoChatService.js';
import { VideoAnalysisResult } from './vibeVideoTypes.js';
import { IWatchedMedia } from './watchMediaReport.js';

export const IVibeWatchMediaService = createDecorator<IVibeWatchMediaService>('vibeWatchMediaService');

/** Кадр, прочитанный с диска */
export interface IWatchFrameBytes {
	readonly timeSec: number;
	readonly width: number;
	readonly height: number;
	readonly sizeBytes: number;
	readonly data: Uint8Array;
}

/** Запись, разобранная движком, пока её временные файлы ещё на месте */
export interface IPreparedWatch {
	readonly media: IWatchedMedia;
	readonly result: VideoAnalysisResult;
	/** Кадры с диска; без номеров — все, в порядке времени */
	readFrames(indices?: readonly number[]): Promise<readonly IWatchFrameBytes[]>;
}

/** Почему разбор не состоялся, и что с этим делать вызывающему */
export type WatchStop =
	/** Отказ с причиной для человека: `severity` подсказывает, как её показать */
	| { readonly kind: 'refused'; readonly severity: 'info' | 'warn' | 'error'; readonly message: string }
	/** Человек остановил сам (отказался от скачивания, нажал «отмена»): шуметь об этом не нужно */
	| { readonly kind: 'cancelled' };

export type WatchRun<T> = { readonly kind: 'done'; readonly value: T } | WatchStop;

export interface IWatchRunOptions {
	/** Ссылка, абсолютный путь, `~/…` или путь от корня проекта — как человек написал */
	readonly input: string;
	/** Нужна ли модели, что получит кадры картинками, способность смотреть изображения: проверка до работы, а не после минут скачивания */
	readonly requireVision: boolean;
	/** Решение о найденной цели до того, как с ней что-то сделано: причина отказа или `undefined`, если можно */
	readonly authorize?: (target: string) => Promise<string | undefined>;
}

/** Как отдать кадры тому, кто вызвал инструмент */
export type WatchToolFrames = 'describe' | 'attach';

export interface IWatchToolRequest {
	readonly input: string;
	readonly question: string;
	readonly frames: WatchToolFrames;
	readonly authorize?: IWatchRunOptions['authorize'];
}

/** Кадр, приложенный к ответу инструмента внешнего агента */
export interface IWatchToolImage {
	readonly mimeType: string;
	/** base64 */
	readonly data: string;
	readonly timeSec: number;
}

export interface IWatchToolReport {
	/** Ответ для модели: материал записи и вопрос, на который по нему отвечать */
	readonly text: string;
	readonly kind: IWatchedMedia['kind'];
	readonly title?: string;
	readonly durationSec?: number;
	/** Сколько кадров вошло в ответ (описанных или приложенных) */
	readonly frameCount: number;
	/** Кто описал кадры, если описание было */
	readonly describedBy?: string;
	/** Приложенные кадры; есть только при `frames: 'attach'` */
	readonly images: readonly IWatchToolImage[];
}

export interface IVibeWatchMediaService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeState: Event<IVibeVideoChatState>;
	getState(): IVibeVideoChatState;

	/** Остановить идущий разбор: убивает дочерние процессы и чистит временные файлы */
	cancel(): void;

	/**
	 * Разобрать запись и отдать её `consume`; временные файлы живут, пока `consume` не закончил
	 * Разбор идёт один за раз. Сбой конвейера бросается; отказ и остановку возвращает значение
	 */
	run<T>(options: IWatchRunOptions, consume: (prepared: IPreparedWatch) => Promise<T>): Promise<WatchRun<T>>;

	/**
	 * Разобрать запись для инструмента: готовый ответ текстом (и кадрами, если просили приложить)
	 * Любая причина, по которой ответа нет, бросается ошибкой с текстом для человека и модели
	 */
	forTool(request: IWatchToolRequest): Promise<IWatchToolReport>;

	/** Показать человеку сбой конвейера; для устаревшего yt-dlp — с кнопкой «Обновить» */
	reportFailure(error: unknown): void;
}
