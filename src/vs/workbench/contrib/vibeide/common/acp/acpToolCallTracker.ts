/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Сборка правки из кадров одного вызова инструмента.
 *
 * Зачем отдельная сущность. Агент рассказывает о вызове несколькими кадрами, и «было → стало»
 * приезжает НЕ в том, который объявляет завершение: проверено живым прогоном с Claude Code — в
 * завершающем кадре остаётся только текстовый итог, а дифф был в предыдущем. Слушатель, ждущий
 * диффа от завершающего кадра, не запишет в журнал ни одной правки.
 *
 * Логика чистая и потому лежит здесь, а не рядом с журналом: это единственный способ проверить её
 * без окна, IPC и живого агента.
 */

import { AcpToolStatus, IAcpDiff } from './acpProtocol.js';

/** Завершённый вызов: всё, что о нём известно к концу. */
export interface IAcpFinishedToolCall {
	readonly toolCallId: string;
	readonly title: string;
	readonly diffs: readonly IAcpDiff[];
	readonly failed: boolean;
}

export class AcpToolCallTracker {

	private readonly _open = new Map<string, { title: string; diffs: readonly IAcpDiff[] }>();

	/**
	 * Принять кадр. Возвращает вызов, если он на этом кадре закончился, иначе `undefined`.
	 *
	 * Поздний кадр дополняет ранний, но не обедняет его: пустое название и пустой дифф ничего не
	 * уточняют, а затерев ими накопленное, мы потеряем именно то, ради чего копили.
	 */
	accept(toolCallId: string, title: string, status: AcpToolStatus, diffs: readonly IAcpDiff[]): IAcpFinishedToolCall | undefined {
		const known = this._open.get(toolCallId);
		const merged = {
			title: title || known?.title || '',
			diffs: diffs.length > 0 ? diffs : (known?.diffs ?? []),
		};
		this._open.set(toolCallId, merged);

		if (status !== 'completed' && status !== 'failed') { return undefined; }
		this._open.delete(toolCallId);
		return { toolCallId, title: merged.title, diffs: merged.diffs, failed: status === 'failed' };
	}

	/** Ход кончился: недосказанные вызовы досказаны не будут, держать их незачем. */
	reset(): void {
		this._open.clear();
	}

	/** Сколько вызовов ещё не закончились — для диагностики зависшего хода. */
	get openCount(): number {
		return this._open.size;
	}
}
