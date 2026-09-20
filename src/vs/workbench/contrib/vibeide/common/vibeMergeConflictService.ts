/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Разбор конфликтов слияния: факты о файле, а не догадка о том, чья версия лучше.
 *
 * ЧТО УБРАНО И ПОЧЕМУ (18.09.2026): прежний разбор выбирал сторону эвристикой «блок короче — тот и
 * берём» и помечал ответ уверенностью `low`. Потребителей у него не было ни одного, а сам выбор —
 * это ровно то решение, которое нельзя принимать по длине: короткая сторона бывает удалением чужой
 * работы. Claude Code в той же ситуации оставляет конфликт обычным конфликтом и передаёт его
 * агенту — решение принимает тот, кто читает код, а не счётчик строк.
 *
 * Поэтому здесь остаётся разбор: где блоки, чьи они, что в них. Решение принимает агент, получив
 * файлы командой «Разрешить конфликты слияния».
 */

/** Один конфликтный блок, как он записан в файле. */
export interface MergeConflictBlock {
	/** Номер строки с `<<<<<<<`, считая с единицы — по нему открывают место в редакторе. */
	readonly startLine: number;
	/** Подпись нашей стороны из маркера (обычно `HEAD`). */
	readonly ourLabel: string;
	/** Подпись чужой стороны из маркера (ветка или коммит). */
	readonly theirLabel: string;
	readonly ourLines: readonly string[];
	readonly theirLines: readonly string[];
	/** Блок закрыт маркером `>>>>>>>`; незакрытый — испорченный файл, о нём говорят отдельно. */
	readonly closed: boolean;
}

export interface MergeConflictReport {
	readonly filePath: string;
	readonly blocks: readonly MergeConflictBlock[];
	/** Есть незакрытый блок: файл резали руками, и его нельзя разбирать как обычный конфликт. */
	readonly malformed: boolean;
}

const CONFLICT_START = '<<<<<<< ';
const CONFLICT_SEP = '=======';
const CONFLICT_END = '>>>>>>> ';

/** Разобрать содержимое файла на конфликтные блоки. Чистая функция — тестируется без репозитория. */
export function parseMergeConflicts(filePath: string, content: string): MergeConflictReport {
	const blocks: MergeConflictBlock[] = [];
	const lines = content.split('\n');
	let current: { startLine: number; ourLabel: string; ourLines: string[]; theirLines: string[] } | undefined;
	let side: 'ours' | 'theirs' = 'ours';
	let malformed = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith(CONFLICT_START)) {
			if (current) {
				// Вложенный или незакрытый блок — дальше разбирать нечего, файл не в том состоянии.
				malformed = true;
			}
			current = { startLine: i + 1, ourLabel: line.slice(CONFLICT_START.length).trim(), ourLines: [], theirLines: [] };
			side = 'ours';
			continue;
		}
		if (!current) {
			continue;
		}
		if (line.trimEnd() === CONFLICT_SEP) {
			side = 'theirs';
			continue;
		}
		if (line.startsWith(CONFLICT_END)) {
			blocks.push({
				startLine: current.startLine,
				ourLabel: current.ourLabel,
				theirLabel: line.slice(CONFLICT_END.length).trim(),
				ourLines: current.ourLines,
				theirLines: current.theirLines,
				closed: true,
			});
			current = undefined;
			continue;
		}
		(side === 'ours' ? current.ourLines : current.theirLines).push(line);
	}

	if (current) {
		malformed = true;
		blocks.push({ startLine: current.startLine, ourLabel: current.ourLabel, theirLabel: '', ourLines: current.ourLines, theirLines: current.theirLines, closed: false });
	}

	return { filePath, blocks, malformed };
}

/** Есть ли в файле неразрешённый конфликт. */
export function hasMergeConflicts(content: string): boolean {
	return content.includes(CONFLICT_START);
}

/**
 * Задание агенту: какие файлы и какие места, без указания, чью сторону брать.
 *
 * Сторону выбирает тот, кто прочитал код; задание называет места и запрещает единственный способ
 * «решить» конфликт, который выглядит как решение, — стереть чужую сторону не читая.
 */
export function describeConflictsForAgent(reports: readonly MergeConflictReport[]): string {
	const lines: string[] = ['Разреши конфликты слияния. Файлы и места:'];
	for (const report of reports) {
		const places = report.blocks.map(block => `строка ${block.startLine} (${block.ourLabel || 'наша сторона'} ↔ ${block.theirLabel || 'чужая сторона'})`).join('; ');
		lines.push(`- ${report.filePath}: ${report.blocks.length} конфликт(ов) — ${places}${report.malformed ? ' [есть незакрытый маркер: файл правили руками]' : ''}`);
	}
	lines.push('');
	lines.push('Правила: прочитай обе стороны и оставь тот код, который сохраняет смысл обеих правок.');
	lines.push('Выбирать сторону по длине блока или стирать чужую не читая — нельзя.');
	lines.push('Маркеры конфликта удали полностью, после правки прогони проверки проекта.');
	return lines.join('\n');
}
