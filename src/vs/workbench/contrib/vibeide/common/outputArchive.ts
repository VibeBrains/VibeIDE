/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Архив сырого вывода команд: сжатие, из которого можно вернуться.
 *
 * Сжатие вывода (`commandOutputCompressor`) экономит контекст, но до сих пор было **необратимым**:
 * увидев `[… +230 passing tests]`, агент мог достать подробность единственным способом — перезапустив
 * команду. Это дорого, а для недетерминированного прогона ещё и не даёт того же вывода.
 *
 * Архив хранит сырой текст ДО сжатия и выдаёт короткую ссылку, по которой его можно развернуть
 * целиком или построчным поиском. Хранилище кольцевое и живёт в памяти окна: вывод команд — это
 * рабочая шелуха сессии, писать её на диск значило бы копить чужие секреты из логов и переменных
 * окружения там, где никто не ждёт.
 *
 * Чистый модуль: ни файловой системы, ни сервисов — проверяется из `test/common/`.
 */

/** Сколько последних выводов держим. Дальше — вытеснение самого старого. */
export const ARCHIVE_CAPACITY = 24;

/** Ниже этого размера архивировать нечего: разворачивать будет нечего. */
export const ARCHIVE_MIN_CHARS = 2000;

/** Сколько строк отдаём за один разворот, чтобы ответ сам не съел контекст. */
export const EXPAND_LINE_LIMIT = 400;

export interface IArchivedOutput {
	readonly ref: string;
	readonly command: string;
	readonly raw: string;
	readonly createdAtMs: number;
}

export interface IExpandResult {
	readonly found: boolean;
	readonly command?: string;
	readonly text?: string;
	readonly totalLines?: number;
	readonly shownLines?: number;
	readonly truncated?: boolean;
	readonly message: string;
}

/**
 * Кольцевой архив.
 *
 * Ссылка выдаётся счётчиком, а не хешем содержимого: два одинаковых прогона одной команды — это
 * два разных события, и склеивать их в одну ссылку значит потерять более свежее.
 */
export class OutputArchive {
	private readonly _entries: IArchivedOutput[] = [];
	private _counter = 0;

	constructor(private readonly _capacity: number = ARCHIVE_CAPACITY) { }

	/**
	 * Кладёт сырой вывод и возвращает ссылку, либо `undefined`, если архивировать нечего:
	 * короткий вывод и вывод, который сжатие не тронуло, разворачивать не из чего.
	 */
	store(command: string, raw: string, compressed: string, nowMs: number): string | undefined {
		if (!raw || raw.length < ARCHIVE_MIN_CHARS || compressed.length >= raw.length) {
			return undefined;
		}
		this._counter += 1;
		const ref = `o${this._counter.toString(36)}`;
		this._entries.push({ ref, command, raw, createdAtMs: nowMs });
		while (this._entries.length > this._capacity) {
			this._entries.shift();
		}
		return ref;
	}

	/**
	 * Разворачивает вывод по ссылке; `query` фильтрует строки подстрокой (без учёта регистра).
	 *
	 * Вытесненная ссылка отвечает отдельным сообщением, а не пустотой: «архив уже не хранит» и
	 * «в выводе ничего не нашлось» требуют от агента разного.
	 */
	expand(ref: string, query?: string, limit: number = EXPAND_LINE_LIMIT): IExpandResult {
		const normalized = normalizeRef(ref);
		const entry = this._entries.find(candidate => candidate.ref === normalized);
		if (!entry) {
			return {
				found: false,
				message: `Вывод ${normalized} в архиве не найден: ссылка устарела (хранятся последние ${this._capacity}) или указана неверно.`,
			};
		}
		const all = entry.raw.split('\n');
		const matched = query?.trim()
			? all.filter(line => line.toLowerCase().includes(query.trim().toLowerCase()))
			: all;
		const shown = matched.slice(0, limit);
		return {
			found: true,
			command: entry.command,
			text: shown.join('\n'),
			totalLines: matched.length,
			shownLines: shown.length,
			truncated: matched.length > shown.length,
			message: query?.trim()
				? `Строк по запросу «${query.trim()}»: ${matched.length}, показано ${shown.length}.`
				: `Полный вывод: строк ${all.length}, показано ${shown.length}.`,
		};
	}

	/** Для тестов и диагностики: сколько выводов сейчас в архиве. */
	get size(): number {
		return this._entries.length;
	}
}

/** Метка, которой сжатый вывод сообщает агенту, где взять полный текст. */
export function archiveMarker(ref: string, raw: string, compressed: string): string {
	const savedLines = raw.split('\n').length - compressed.split('\n').length;
	const lines = savedLines > 0 ? `${savedLines} строк свёрнуто; ` : '';
	return `\n[vibe#${ref}: ${lines}полный вывод — expand_output ref="${ref}"]`;
}

/**
 * Приводит ссылку к каноническому виду.
 *
 * Модели переносят в аргумент то, что видят в тексте, — вместе со скобками и префиксом. Отказ на
 * `[vibe#o1]` был бы отказом ради формальности: что имелось в виду, понятно однозначно.
 */
export function normalizeRef(ref: string): string {
	const match = /o[0-9a-z]+/i.exec((ref ?? '').trim());
	return match ? match[0].toLowerCase() : (ref ?? '').trim();
}
