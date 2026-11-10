/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Блок `<task_source>` для сводки старой части переписки.
 *
 * После сжатия истории исходное сообщение с задачей уходит в пересказ, и модель теряет
 * требования, по которым её проверяют. Бриф лежит на диске отдельным файлом, поэтому вернуть
 * его в промпт дешевле, чем хранить всю переписку.
 */

/** Потолок текста брифа в блоке; обёртка и путь считаются отдельно в резерве бюджета. */
export const TASK_SOURCE_MAX_CHARS = 6000;

/** Потолок заметки «что сохранить»: произвольный текст иначе раздул бы сводку. */
export const PRESERVE_NOTE_MAX_CHARS = 2000;

/** Заголовки, теги и хвост обрезки; входят в резерв бюджета рядом с лимитами текста. */
export const TASK_SOURCE_WRAPPER_MAX_CHARS = 512;

export interface CompactionTaskSource {
	readonly text: string;
	readonly path: string;
}

function truncateAtLine(text: string, maxChars: number, tail: string): string {
	if (text.length <= maxChars) { return text; }
	const head = text.slice(0, maxChars);
	const lastBreak = head.lastIndexOf('\n');
	// Режем по границе строки: обрывок строки модель прочитает как повреждённый текст
	const cut = lastBreak > 0 ? head.slice(0, lastBreak) : head;
	return `${cut}\n${tail}`;
}

/**
 * Собрать блок из брифа и необязательной заметки «что сохранить».
 *
 * Пустой ввод даёт пустую строку: блок без содержания только тратил бы бюджет.
 */
export function buildTaskSourceBlock(source: CompactionTaskSource | undefined, preserveNote?: string): string {
	const briefText = source?.text.trim() ?? '';
	const note = preserveNote?.trim() ?? '';
	if (!briefText && !note) { return ''; }

	const sections: string[] = [];
	if (briefText) {
		const path = source?.path.trim() || 'файл брифа';
		const body = truncateAtLine(briefText, TASK_SOURCE_MAX_CHARS, `бриф обрезан, полный текст — ${path}`);
		sections.push(`Бриф задачи (полный текст — ${path}):\n${body}`);
	}
	if (note) {
		const body = truncateAtLine(note, PRESERVE_NOTE_MAX_CHARS, 'заметка обрезана');
		sections.push(`Что сохранить после сжатия:\n${body}`);
	}
	return `<task_source>\n${sections.join('\n\n')}\n</task_source>`;
}
