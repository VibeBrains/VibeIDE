/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Договор между окном и главным процессом о распознавании текста на картинке.
 *
 * WHY: распознаватель (`tesseract.js`) создаёт свой фоновый поток из строки —
 * `new Worker('…/worker.min.js')`. Документ воркбенча требует `TrustedScriptURL`, поэтому такой
 * вызов падает ещё до первой буквы: `Failed to construct 'Worker': This document requires
 * 'TrustedScriptURL' assignment`. Подсунуть политику в чужой вызов снаружи нельзя, а выключать
 * Trusted Types ради одной возможности — менять защиту окна на удобство.
 *
 * Поэтому распознавание переехало туда, где этой защиты нет и не должно быть: в главный процесс.
 * Там `tesseract.js` берёт `worker_threads`, окно не занимает свой поток тяжёлой работой, а через
 * канал ходят только байты картинки и готовый текст.
 *
 * Найдено живым смоуком 20.09.2026: страница-скан приходила пустой, а причина была видна только в
 * журнале окна.
 */

/** Имя канала главного процесса. */
export const VIBE_OCR_CHANNEL = 'vibeide-channel-ocr';

/** Что окно шлёт на распознавание. */
export interface OcrRecognizeRequest {
	/**
	 * Картинка целиком в base64, без префикса `data:`.
	 *
	 * Почему строка, а не байты: сериализация канала разворачивает `VSBuffer` только когда он сам
	 * является аргументом, а внутри объекта он уезжает пустым `{}`. Обычный `Uint8Array` доезжает
	 * объектом с числовыми ключами. И то и другое распознаватель встречает одинаково —
	 * «Error attempting to read image», — и обе формы проверены живьём 20.09.2026.
	 */
	readonly imageBase64: string;
	/**
	 * Языки в записи tesseract: `rus+eng` означает «оба сразу».
	 *
	 * По умолчанию русский стоит первым: продукт русский, и сканы у пользователей русские. Вторым
	 * английский — в документах постоянно встречаются латинские слова, имена и адреса.
	 */
	readonly languages: string;
}

/** Одно слово с его местом и уверенностью — из них окно собирает блоки. */
export interface OcrWord {
	readonly text: string;
	readonly confidence: number;
	readonly bbox: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

/**
 * Ответ главного процесса.
 *
 * Исход возвращается полем, а не исключением: `call` канала теряет тип ошибки по дороге, и окно не
 * смогло бы отличить «распознали, но текста нет» от «распознаватель не поднялся». Разница важна —
 * первое значит «страница пустая», второе «проверка не выполнялась».
 */
export type OcrRecognizeResponse =
	| { readonly ok: true; readonly text: string; readonly words: readonly OcrWord[] }
	| { readonly ok: false; readonly error: string };

/** Язык по умолчанию. */
export const OCR_DEFAULT_LANGUAGES = 'rus+eng';
