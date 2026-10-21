/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Текст разбора записи: то, что получает модель после `/watch` и после вызова инструмента `watch_media`
 *
 * Два входа в один движок говорят с моделью по-разному:
 * - `/watch` кладёт кадры картинками в сообщение, и текст только сопоставляет их с тайм-кодами
 * - инструмент отвечает текстом, и картинок в ответе инструмента нет: кадры в нём названы тайм-кодом
 *   и, если нашёлся кто их рассмотреть, описаны
 *
 * Чистый модуль: без файлов, моделей и окружения
 */

import { VideoAnalysisKind, formatVideoTimecode } from './vibeVideoTypes.js';

/** Сколько знаков транскрипта уходит модели: час субтитров занял бы весь бюджет, отведённый кадрам */
export const WATCH_MAX_TRANSCRIPT_CHARS = 60_000;

/** Что разбор узнал о записи */
export interface IWatchedMedia {
	readonly target: string;
	readonly kind: VideoAnalysisKind;
	readonly title?: string;
	readonly durationSec?: number;
	/** Тайм-коды кадров в порядке времени */
	readonly frameTimes: readonly number[];
	readonly transcriptText?: string;
	/** Откуда транскрипт: «субтитры», «распознан локально» или почему его нет */
	readonly transcriptLabel: string;
}

const KIND_LABELS: Record<VideoAnalysisKind, string> = { audio: 'аудиозапись', video: 'видео' };

function transcriptBlock(media: IWatchedMedia): string[] {
	if (!media.transcriptText) {
		return [];
	}
	const truncated = media.transcriptText.length > WATCH_MAX_TRANSCRIPT_CHARS;
	return [
		`Транскрипт (${media.transcriptLabel}${truncated ? '; обрезан по лимиту' : ''}):`,
		truncated ? media.transcriptText.slice(0, WATCH_MAX_TRANSCRIPT_CHARS) : media.transcriptText,
	];
}

function headerLines(media: IWatchedMedia): string[] {
	const lines = [`Источник: ${media.target}`];
	if (media.title) {
		lines.push(`Название: ${media.title}`);
	}
	if (media.durationSec !== undefined) {
		lines.push(`Длительность: ${formatVideoTimecode(media.durationSec)}`);
	}
	return lines;
}

/**
 * Сообщение `/watch`: кадры приложены картинками, текст сопоставляет их с тайм-кодами и ставит задание
 * `hint` — вопрос человека после ссылки; без него модель получает общее задание на разбор
 */
export function composeWatchPrompt(media: IWatchedMedia, hint: string): string {
	const isAudio = media.kind === 'audio';
	const lines: string[] = [isAudio ? 'Разбор аудиозаписи по команде /watch.' : 'Разбор видео по команде /watch.', ...headerLines(media), ''];
	if (!isAudio) {
		lines.push(`К сообщению приложены ${media.frameTimes.length} кадров, вырезанных по сменам сцен (в порядке времени). Соответствие кадров тайм-кодам:`);
		media.frameTimes.forEach((time, index) => {
			lines.push(`Кадр ${index + 1} — ${formatVideoTimecode(time)}`);
		});
		lines.push('');
	}
	const transcript = transcriptBlock(media);
	if (transcript.length > 0) {
		lines.push(...transcript);
	} else {
		// Для аудио недостижимо: прогон без транскрипта на аудио останавливается раньше
		lines.push(`Транскрипта нет (${media.transcriptLabel}) — анализируй только кадры.`);
	}
	lines.push('');
	if (hint) {
		lines.push(`Задание: ${hint}`);
	} else {
		lines.push(isAudio
			? 'Задание: составь разбор аудиозаписи: 1) TL;DR в 3–5 строк; 2) ключевые темы и тезисы с тайм-кодами; 3) кто говорит — атрибутируй по содержанию и явно помечай неуверенность (авто-транскрипт спикеров не размечает); 4) заметные цитаты с тайм-кодами.'
			: 'Задание: составь разбор видео: 1) TL;DR в 3–5 строк; 2) ключевые моменты с тайм-кодами; 3) что показано на экране, но не проговорено в звуке; 4) заметные цитаты/моменты с тайм-кодами. Ссылайся на кадры по номерам и тайм-кодам.');
	}
	return lines.join('\n');
}

/** Что известно о кадрах для ответа инструмента */
export type WatchFrameReport =
	/** Кадры описаны: строки по номерам кадров, кого-то из них могло не оказаться в ответе описывавшего */
	| { readonly kind: 'described'; readonly model: string; readonly descriptions: ReadonlyMap<number, string> }
	/** Кадры уходят картинками отдельно от текста (инструмент внешнего агента) */
	| { readonly kind: 'attached' }
	/** Кадры названы тайм-кодами, а рассмотреть их было некому; `reason` называет причину и что сделать */
	| { readonly kind: 'unseen'; readonly reason: string };

/**
 * Ответ инструмента `watch_media`: материал и вопрос, на который по нему отвечать
 * Выдуманных реплик и сцен модель не получает из пустоты: чего в ответе нет, о том он говорит прямо
 */
export function composeWatchToolReport(media: IWatchedMedia, frames: WatchFrameReport, question: string): string {
	const lines: string[] = [`Разобрано: ${KIND_LABELS[media.kind]}${media.title ? ` «${media.title}»` : ''}.`, ...headerLines(media), ''];
	if (media.kind === 'video' && media.frameTimes.length > 0) {
		lines.push(...frameLines(media.frameTimes, frames), '');
	}
	const transcript = transcriptBlock(media);
	if (transcript.length > 0) {
		lines.push(...transcript);
	} else {
		lines.push(`Транскрипта нет (${media.transcriptLabel}).${media.kind === 'video' ? ' Опирайся только на кадры и не выдумывай реплики.' : ''}`);
	}
	lines.push('', `Вопрос: ${question || 'Перескажи содержание по существу, с опорой на тайм-коды.'}`);
	return lines.join('\n');
}

function frameLines(times: readonly number[], frames: WatchFrameReport): string[] {
	const heading = `Кадры (${times.length}) сняты по сменам сцен, а не через равные промежутки:`;
	switch (frames.kind) {
		case 'described':
			return [
				`${heading} описал ${frames.model}.`,
				...times.map((time, index) => {
					const description = frames.descriptions.get(index + 1);
					return `[${formatVideoTimecode(time)}] Кадр ${index + 1}${description ? `: ${description}` : ''}`;
				}),
			];
		case 'attached':
			return [`${heading} они приложены к ответу картинками, по порядку:`, ...times.map((time, index) => `[${formatVideoTimecode(time)}] Кадр ${index + 1}`)];
		case 'unseen':
			return [`${heading} картинок в ответе инструмента нет, и описать их было некому: ${frames.reason}`, ...times.map((time, index) => `[${formatVideoTimecode(time)}] Кадр ${index + 1}`)];
	}
}

/**
 * Просьба к модели, рассматривающей кадры: по строке на кадр, в разборе по номерам
 * `question` подсказывает, на что смотреть, но ответ остаётся описанием: вывод делает тот, кто получит отчёт
 */
export function composeFrameDescriptionPrompt(times: readonly number[], question: string): string {
	const lines = [
		`К сообщению приложены ${times.length} кадров записи, вырезанных по сменам сцен, в порядке времени.`,
		'Опиши каждый кадр одной строкой в формате «N: что видно» — N номер кадра. Называй то, что есть на экране: окно или страницу, текст, цифры, графики, людей и их действия.',
		'Без вступления и итога, без пересказа звука, ничего не выдумывай: нечитаемое пиши как нечитаемое.',
		'Соответствие кадров тайм-кодам:',
		...times.map((time, index) => `Кадр ${index + 1} — ${formatVideoTimecode(time)}`),
	];
	if (question) {
		lines.push('', `Человек хочет узнать о записи: ${question}`, 'Подробнее описывай то, что относится к этому вопросу.');
	}
	return lines.join('\n');
}

/**
 * Строки вида «3: на экране терминал» → номер кадра и описание
 * Нумерацию принимаем и с точкой, скобкой и тире (модели пишут «3.», «3)», «Кадр 3 — …»); строки без номера пропускаются
 */
export function parseFrameDescriptions(answer: string, frameCount: number): ReadonlyMap<number, string> {
	const descriptions = new Map<number, string>();
	for (const line of answer.split(/\r?\n/)) {
		const match = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:кадр\s*)?(\d{1,3})(?:\*\*)?\s*[:.)\-–—]+\s*(?:\*\*)?(.+?)\s*$/i.exec(line);
		if (!match) {
			continue;
		}
		const index = Number(match[1]);
		const text = match[2].replace(/\*\*/g, '').trim();
		if (index >= 1 && index <= frameCount && text && !descriptions.has(index)) {
			descriptions.set(index, text);
		}
	}
	return descriptions;
}
