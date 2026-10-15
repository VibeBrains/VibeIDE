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

import { AcpToolStatus, IAcpDiff, isToolOpen } from './acpProtocol.js';

export type AcpLogEntry =
	/** Реплика агента: склеенные куски текста. Размышление отделено от ответа признаком. */
	| { readonly kind: 'message'; readonly id: string; readonly text: string; readonly thought: boolean }
	/** Карточка вызова инструмента: одна на вызов, обновляется по мере кадров. */
	| { readonly kind: 'tool'; readonly id: string; readonly title: string; readonly name: string; readonly toolKind: string; readonly status: AcpToolStatus; readonly paths: readonly string[]; readonly diffs: readonly IAcpDiff[]; readonly output: string; readonly exitCode?: number }
	/**
	 * A note from the editor, not from the agent: what happened to the session itself, e.g. that the
	 * connection came back and whether the agent still remembers the conversation above.
	 */
	| { readonly kind: 'notice'; readonly id: string; readonly text: string };

/**
 * Кадр вызова инструмента для карточки.
 *
 * Объектом, а не списком позиций: полей стало семь, и порядок из семи строк — это ошибка, которую
 * не увидит ни компилятор (все строки), ни читатель.
 */
export interface AcpToolFrame {
	readonly toolCallId: string;
	readonly title: string;
	/** Программное имя инструмента; пусто — агент его не прислал. */
	readonly name: string;
	readonly toolKind: string;
	readonly status: AcpToolStatus;
	readonly paths: readonly string[];
	readonly diffs: readonly IAcpDiff[];
	/** What the call printed or returned, cut to `ACP_TOOL_OUTPUT_MAX_CHARS`; empty — nothing yet */
	readonly output: string;
	/** Exit code of a command; absent until it ends and for calls that are not commands */
	readonly exitCode?: number;
}

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
	/** Set by `beginTurn`: the next text starts a new message even if the last entry is a message of the same kind */
	private _turnSealed = false;

	get snapshot(): IAcpSessionSnapshot {
		return { entries: this._entries, spend: this._spend };
	}

	/**
	 * A new turn begins: its first text does not join the last message of the previous turn
	 * Returns where the turn starts in `entries`; whoever mirrors the log follows it from there
	 */
	beginTurn(): number {
		this._turnSealed = true;
		return this._entries.length;
	}

	/**
	 * The turn is over: a call that never reported its end is not running any more
	 * Stopping in the middle of a question leaves such cards, and «in progress» on them would never go away
	 */
	settleTurn(): void {
		if (!this._entries.some(entry => entry.kind === 'tool' && isToolOpen(entry.status))) { return; }
		this._entries = this._entries.map(entry => entry.kind === 'tool' && isToolOpen(entry.status) ? { ...entry, status: 'cancelled' } : entry);
	}

	/** A note about the session itself; like a tool call, it breaks the gluing of the agent's text. */
	appendNotice(text: string): void {
		this._entries = [...this._entries, { kind: 'notice', id: `n${this._nextMessageId++}`, text }];
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
		if (!this._turnSealed && last?.kind === 'message' && last.thought === thought) {
			this._entries = [...this._entries.slice(0, -1), { ...last, text: last.text + text }];
			return;
		}
		this._turnSealed = false;
		this._entries = [...this._entries, { kind: 'message', id: `m${this._nextMessageId++}`, text, thought }];
	}

	/**
	 * Кадр вызова инструмента: одна карточка на вызов.
	 *
	 * Поздний кадр дополняет карточку, но не обедняет её — пустое название, пустые пути и пустой
	 * дифф ничего не уточняют. Проверено живьём: завершающий кадр приходит без диффа, и затерев
	 * им накопленное, поверхность показала бы правку без содержимого.
	 */
	applyTool(frame: AcpToolFrame): void {
		const { toolCallId, title, name, toolKind, status, paths, diffs, output, exitCode } = frame;
		const index = this._entries.findIndex(entry => entry.kind === 'tool' && entry.id === toolCallId);
		if (index === -1) {
			this._entries = [...this._entries, { kind: 'tool', id: toolCallId, title, name, toolKind, status, paths, diffs, output, ...(exitCode === undefined ? {} : { exitCode }) }];
			return;
		}
		const known = this._entries[index] as Extract<AcpLogEntry, { kind: 'tool' }>;
		const mergedExitCode = exitCode ?? known.exitCode;
		const merged: AcpLogEntry = {
			kind: 'tool',
			id: toolCallId,
			title: title || known.title,
			name: name || known.name,
			toolKind: toolKind || known.toolKind,
			// Стадия — единственное, что законно меняется в любую сторону: вызов может провалиться.
			status,
			paths: paths.length > 0 ? paths : known.paths,
			diffs: diffs.length > 0 ? diffs : known.diffs,
			// Like the diff, the output and the exit code arrive in their own frame: a later frame without them does not erase them
			output: output || known.output,
			...(mergedExitCode === undefined ? {} : { exitCode: mergedExitCode }),
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
