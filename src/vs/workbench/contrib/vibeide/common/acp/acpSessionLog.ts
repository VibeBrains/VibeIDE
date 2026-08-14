/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Лента сессии внешнего агента: то, что видит человек на поверхности.
 *
 * Событий от агента много и они мелкие: текст приезжает кусками по несколько символов, а один
 * вызов инструмента описывается пятью кадрами подряд. Показывать их как есть нельзя — получится
 * поток строк вместо разговора. Здесь куски склеиваются в реплики, кадры одного вызова
 * сворачиваются в одну карточку, а расход хода держится последним значением.
 *
 * Слой чистый: ни React, ни IPC, ни агента — поэтому проверяется из `test/common/`.
 */

import { AcpToolStatus, IAcpDiff } from './acpProtocol.js';

export type AcpLogEntry =
	/** Реплика агента: склеенные куски текста. Размышление отделено от ответа признаком. */
	| { readonly kind: 'message'; readonly id: string; readonly text: string; readonly thought: boolean }
	/** Карточка вызова инструмента: одна на вызов, обновляется по мере кадров. */
	| { readonly kind: 'tool'; readonly id: string; readonly title: string; readonly toolKind: string; readonly status: AcpToolStatus; readonly paths: readonly string[]; readonly diffs: readonly IAcpDiff[] };

/** Расход хода: контекст и деньги. */
export interface IAcpSessionSpend {
	readonly used: number;
	readonly size: number;
	readonly costUsd?: number;
}

export interface IAcpSessionSnapshot {
	readonly entries: readonly AcpLogEntry[];
	readonly spend?: IAcpSessionSpend;
}

export class AcpSessionLog {

	private _entries: AcpLogEntry[] = [];
	private _spend: IAcpSessionSpend | undefined;
	/** Порядковый номер реплики: идентификатор нужен списку, чтобы не перерисовывать всё подряд. */
	private _nextMessageId = 1;

	get snapshot(): IAcpSessionSnapshot {
		return { entries: this._entries, spend: this._spend };
	}

	/**
	 * Кусок текста.
	 *
	 * Приклеивается к последней реплике того же рода. Вызов инструмента разрывает склейку:
	 * текст до действия и текст после — разные реплики, и слипшись, они читались бы как одна
	 * мысль, произнесённая до того, как агент что-то узнал.
	 */
	appendText(text: string, thought: boolean): void {
		if (!text) { return; }
		const last = this._entries[this._entries.length - 1];
		if (last?.kind === 'message' && last.thought === thought) {
			this._entries = [...this._entries.slice(0, -1), { ...last, text: last.text + text }];
			return;
		}
		this._entries = [...this._entries, { kind: 'message', id: `m${this._nextMessageId++}`, text, thought }];
	}

	/**
	 * Кадр вызова инструмента: одна карточка на вызов.
	 *
	 * Поздний кадр дополняет карточку, но не обедняет её — пустое название, пустые пути и пустой
	 * дифф ничего не уточняют. Проверено живьём: завершающий кадр приходит без диффа, и затерев
	 * им накопленное, поверхность показала бы правку без содержимого.
	 */
	applyTool(toolCallId: string, title: string, toolKind: string, status: AcpToolStatus, paths: readonly string[], diffs: readonly IAcpDiff[]): void {
		const index = this._entries.findIndex(entry => entry.kind === 'tool' && entry.id === toolCallId);
		if (index === -1) {
			this._entries = [...this._entries, { kind: 'tool', id: toolCallId, title, toolKind, status, paths, diffs }];
			return;
		}
		const known = this._entries[index] as Extract<AcpLogEntry, { kind: 'tool' }>;
		const merged: AcpLogEntry = {
			kind: 'tool',
			id: toolCallId,
			title: title || known.title,
			toolKind: toolKind || known.toolKind,
			// Стадия — единственное, что законно меняется в любую сторону: вызов может провалиться.
			status,
			paths: paths.length > 0 ? paths : known.paths,
			diffs: diffs.length > 0 ? diffs : known.diffs,
		};
		this._entries = [...this._entries.slice(0, index), merged, ...this._entries.slice(index + 1)];
	}

	/**
	 * Расход.
	 *
	 * Значения приходят накопительными за сессию, поэтому последнее заменяет прежнее. Складывать
	 * их значило бы посчитать одни и те же токены столько раз, сколько пришло кадров.
	 */
	applySpend(used: number, size: number, costUsd: number | undefined): void {
		this._spend = { used, size, ...(costUsd === undefined ? {} : { costUsd }) };
	}
}
