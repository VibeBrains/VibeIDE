/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Правки внешнего агента, сделанные им самим: какой файл был до правки
 *
 * Claude Code пишет файл своими инструментами и клиентскую `fs/write_text_file` не зовёт,
 * поэтому о правке клиент узнаёт из кадров вызова, когда файл уже записан
 * Разбор в общем механизме ревью (принять и отклонить) нуждается в двух текстах: «до» и «после»
 *
 * «После» — это диск на момент, когда вызов завершился, а не `newText` из диффа:
 * у `Edit` дифф несёт обрывки файла, у `Write` `oldText` пуст даже для файла, который уже был
 * «До» — файл, снятый при первом взгляде на вызов, пока агент ещё ничего не записал
 * Первое касание файла в ходу задаёт базу, последующие правки её не переписывают:
 * отклонить значит вернуть файл к состоянию на начало хода, а не на начало последней правки
 *
 * Базу честно сняли не всегда: быстрый вызов успевает записать файл раньше, чем мы его прочли
 * Тогда база совпадает с диском, и если дифф позволяет однозначно вернуть прежний текст, он возвращается;
 * иначе правка не заводится на разбор — угаданная база сделала бы «отклонить» разрушительным
 *
 * Слой чистый: диска здесь нет, поэтому проверяется из `test/common/`
 */

import { isAbsolute, relative } from '../../../../../base/common/path.js';
import { IAcpDiff } from './acpProtocol.js';

/** Вид вызова, который правит файлы; остальные виды (команды, чтение, удаление) в ревью не идут */
export const ACP_EDIT_TOOL_KIND = 'edit';

/** Файл крупнее не читается: база нужна для показа и отката, а не для хранения образа проекта */
export const ACP_BEFORE_MAX_BYTES = 1_048_576;

/**
 * Файл, каким его застали до правки
 * Файл, который не удалось прочитать как текст (двоичный, не UTF-8, слишком большой), сюда не попадает:
 * о нём ничего достоверного сказать нельзя
 */
export type AcpFileBefore =
	| { readonly path: string; readonly state: 'text'; readonly text: string }
	/** Файла не было: его создал агент */
	| { readonly path: string; readonly state: 'absent' };

/** Текст файла до правки; `null` — файла не было */
export type AcpBaseline = string | null;

/** Строки в модели редактора всегда с `\n`, поэтому и тексты сравниваются так */
export function normalizeEol(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * Текст файла из байтов, как его прочла бы модель редактора; `undefined` — это не текст в UTF-8
 * Файл в другой кодировке прочитался бы мусором, и база из мусора отличалась бы от модели в каждой строке
 */
export function decodeBaseline(bytes: Uint8Array): string | undefined {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^﻿/, '');
	} catch {
		return undefined;
	}
}

/** Лежит ли путь внутри корня; читать для базы можно только то, что в рабочей папке сессии */
export function isInsideRoot(root: string, path: string): boolean {
	if (!isAbsolute(path)) { return false; }
	const rel = relative(root, path);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Базы файлов в пределах одного хода; первое касание файла задаёт базу */
export class AcpEditLedger {

	private readonly _before = new Map<string, AcpBaseline>();

	remember(files: readonly AcpFileBefore[]): void {
		for (const file of files) {
			if (this._before.has(file.path)) { continue; }
			this._before.set(file.path, file.state === 'text' ? normalizeEol(file.text) : null);
		}
	}

	baselineOf(path: string): AcpBaseline | undefined {
		return this._before.get(path);
	}

	/** Начался новый ход: база прежнего хода уже разобрана или принята как есть */
	clear(): void {
		this._before.clear();
	}
}

/** Что делать с правкой файла, когда вызов завершился */
export type AcpBaselineVerdict =
	/** Завести на разбор против этого текста */
	| { readonly kind: 'text'; readonly text: string }
	/** Файла не было: отклонить значит убрать файл */
	| { readonly kind: 'created' }
	/** На разбор нечего вести */
	| { readonly kind: 'skip'; readonly reason: 'unchanged' | 'ambiguous' };

export interface IAcpBaselineInput {
	/** База, снятая при первом касании файла в ходу; `undefined` — снять не удалось */
	readonly remembered: AcpBaseline | undefined;
	/** Текст файла на диске сейчас */
	readonly current: string;
	/** Дифф вызова для этого файла, если агент его прислал */
	readonly diff?: IAcpDiff;
}

/** Первое вхождение подстроки заменяется, только если оно единственное; иначе `undefined` */
function replaceOnce(text: string, find: string, replacement: string): string | undefined {
	const at = text.indexOf(find);
	if (at === -1 || at !== text.lastIndexOf(find)) { return undefined; }
	return text.slice(0, at) + replacement + text.slice(at + find.length);
}

/**
 * База правки: снятая в начале хода, а когда она совпала с диском — восстановленная по диффу
 * Совпадение с диском означает, что вызов записал файл раньше, чем мы успели его прочесть,
 * либо что правка ничего не изменила; отличить эти случаи можно только по диффу
 */
export function resolveBaseline(input: IAcpBaselineInput): AcpBaselineVerdict {
	const current = normalizeEol(input.current);
	const { remembered } = input;
	if (remembered === null) {
		return current === '' ? { kind: 'skip', reason: 'unchanged' } : { kind: 'created' };
	}
	if (remembered !== undefined && remembered !== current) {
		return { kind: 'text', text: remembered };
	}
	// База совпала с диском или её нет вовсе: восстановить прежний текст можно только обратной подстановкой
	// У записи файла целиком `oldText` пуст, у удаления `newText` пуст: место правки по ним не найти
	const oldText = input.diff ? normalizeEol(input.diff.oldText) : '';
	const newText = input.diff ? normalizeEol(input.diff.newText) : '';
	if (oldText === '' || newText === '' || oldText === newText) {
		return { kind: 'skip', reason: remembered === undefined ? 'ambiguous' : 'unchanged' };
	}
	const restored = replaceOnce(current, newText, oldText);
	return restored === undefined ? { kind: 'skip', reason: 'ambiguous' } : { kind: 'text', text: restored };
}
