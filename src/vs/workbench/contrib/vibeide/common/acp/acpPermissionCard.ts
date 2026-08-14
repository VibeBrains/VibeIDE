/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Вопрос внешнего агента, свёрнутый до размера телефона.
 *
 * На вкладке дифф показывается целиком, здесь — нет: решение принимается большим пальцем в
 * дороге, и правка на двести строк, вываленная в чат, не делает его обоснованнее. Показываем
 * то, по чему решение принимается на самом деле: что за действие, какие файлы и сколько строк
 * меняется, — а начало правки даём как образец.
 *
 * Слой чистый: ни Telegram-API, ни сервисов — поэтому проверяется из `test/common/`.
 */

import { AcpStopReason, IAcpDiff } from './acpProtocol.js';
import { IAcpSessionSpend } from './acpSessionLog.js';

/** Сколько строк правки показывать в карточке: остальное — за компьютером. */
export const ACP_CARD_DIFF_LINES = 6;

/** Сколько файлов перечислять поимённо, прежде чем свернуть остаток в счётчик. */
const ACP_CARD_MAX_PATHS = 5;

export interface IAcpCardInput {
	readonly agentName: string;
	readonly title: string;
	readonly paths: readonly string[];
	readonly diffs: readonly IAcpDiff[];
}

/**
 * Карточка в Markdown — его мост уже умеет превращать в разметку Telegram.
 *
 * Пути показываются полностью, а не хвостом: два файла с одинаковым именем в разных папках —
 * обычное дело, и «правлю index.ts» не отвечает на вопрос, какой именно.
 */
export function formatAcpPermissionCard(input: IAcpCardInput): string {
	const lines: string[] = [`🤝 **${input.agentName}** просит разрешения`, '', input.title || 'действие без названия'];

	const shown = input.paths.slice(0, ACP_CARD_MAX_PATHS);
	if (shown.length > 0) {
		lines.push('');
		for (const path of shown) { lines.push(`\`${path}\``); }
		const hidden = input.paths.length - shown.length;
		if (hidden > 0) { lines.push(`…и ещё ${hidden}`); }
	}

	for (const diff of input.diffs) {
		const removed = splitLines(diff.oldText);
		const added = splitLines(diff.newText);
		lines.push('', `\`${diff.path}\` — −${removed.length}/+${added.length} строк`);
		const preview = [
			...removed.slice(0, ACP_CARD_DIFF_LINES).map(line => `− ${line}`),
			...added.slice(0, ACP_CARD_DIFF_LINES).map(line => `+ ${line}`),
		];
		if (preview.length > 0) {
			lines.push('```', ...preview, '```');
		}
		if (removed.length > ACP_CARD_DIFF_LINES || added.length > ACP_CARD_DIFF_LINES) {
			lines.push('_Показано начало правки — целиком видно во вкладке «Внешние агенты»._');
		}
	}

	return lines.join('\n');
}

/** Пустой текст — это ноль строк: так выглядит создание файла и удаление содержимого. */
const splitLines = (text: string): readonly string[] => (text ? text.split('\n') : []);

/**
 * Какой вариант агента означает «да».
 *
 * Кнопок у нас три и они фиксированы, а варианты придумывает агент. Разрешение — это вариант с
 * видом `allow_once`: разовое согласие, а не «разрешать всегда», которое человек с телефона
 * выдал бы не глядя. Отказ вариантом НЕ выражается — на него есть отмена, потому что угадывать,
 * какой из чужих вариантов означает «нет», нельзя.
 */
export function allowOptionOf(options: readonly { readonly optionId: string; readonly kind: string }[]): string | undefined {
	return options.find(option => option.kind === 'allow_once')?.optionId
		?? options.find(option => option.kind === 'allow_always')?.optionId;
}

/**
 * Итог хода для телефона: чем кончилось и во что обошлось.
 *
 * Расход показывается здесь, а не в ленте, по простой причине: с телефона его больше негде
 * увидеть, а «сколько это стоило» — первый вопрос после «сделал ли».
 */
export function formatAcpTurnEnd(stopReason: AcpStopReason | undefined, spend: IAcpSessionSpend | undefined): string {
	const ending = stopReason ? TURN_END_NAMES[stopReason] : 'ход закончился';
	if (!spend) { return ending; }
	const context = `${spend.used.toLocaleString('ru-RU')} / ${spend.size.toLocaleString('ru-RU')} токенов`;
	// Цена приходит в долларах; переводить её в рубли по выдуманному курсу мы не вправе.
	return spend.costUsd === undefined ? `${ending}\n${context}` : `${ending}\n${context} · $${spend.costUsd.toFixed(4)}`;
}

const TURN_END_NAMES: Record<AcpStopReason, string> = {
	'completed': '✅ Готово.',
	'cancelled': '⛔️ Ход прерван.',
	'refusal': '🚫 Агент отказался выполнять задачу.',
	'max_turns': '⏹ Агент упёрся в предел шагов.',
	'max_tokens': '⏹ Агент упёрся в предел токенов.',
	'unknown': '❔ Агент остановился, не назвав причину.',
};
