/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Requirement, TaskBrief } from './taskBrief.js';

/**
 * Файл брифа `.vibe/plans/<id>.brief.md` — что записано на диск и как читается обратно.
 *
 * ОДИН ИСТОЧНИК ПРАВДЫ: текст задачи и смещения. Цитата в списке требований печатается для
 * человека, но при чтении НЕ разбирается — она восстанавливается из текста по смещениям. Иначе
 * правка цитаты руками разошлась бы с текстом молча, и главный инвариант («цитата дословна»)
 * перестал бы что-либо значить.
 *
 * Формат markdown, а не JSON, намеренно: бриф читают глазами и обсуждают, а требования — это то,
 * что человек проверяет перед одобрением плана.
 */

const MARKER = '<!-- vibe:brief';
const TEXT_FENCE = '```text';

/** Записать бриф. Текст уходит в блок дословно, требования — списком со смещениями. */
export function serializeBrief(brief: TaskBrief): string {
	const lines: string[] = [
		`${MARKER} id=${brief.id} createdAt=${brief.createdAt} -->`,
		'',
		'# Задача',
		'',
		'> Текст ниже — то, что написал человек. Требования считаются от него по смещениям,',
		'> поэтому правка текста здесь меняет и требования: правьте задачу в чате, а не файл.',
		'',
		TEXT_FENCE,
		brief.text,
		'```',
		'',
		'## Требования',
		'',
	];
	if (brief.requirements.length === 0) {
		lines.push('_Требований не выделено._');
	}
	for (const requirement of brief.requirements) {
		const mark = requirement.waived ? 'x' : ' ';
		const tail = requirement.waived
			? ` — снято пользователем ${new Date(requirement.waived.at).toISOString().slice(0, 10)}: ${requirement.waived.reason}`
			: '';
		lines.push(`- [${mark}] ${requirement.id} (${requirement.start}–${requirement.end}) ${requirement.quote}${tail}`);
	}
	lines.push('');
	return lines.join('\n');
}

const HEAD_RE = /^<!-- vibe:brief id=(\S+) createdAt=(\d+) -->/;
const ITEM_RE = /^- \[( |x)\]\s+(\S+)\s+\((\d+)–(\d+)\)\s*(?:(.*?)(?:\s+—\s+снято пользователем (\d{4}-\d{2}-\d{2}):\s*(.*))?)?$/;

/**
 * Прочитать бриф. `undefined` — файл не наш или испорчен настолько, что доверять ему нельзя.
 *
 * Требование со смещениями за пределами текста отбрасывается: восстановить его нечем, а оставить
 * с пустой цитатой значило бы молча превратить обязательство в пустоту.
 */
export function parseBriefFile(content: string): TaskBrief | undefined {
	const head = HEAD_RE.exec(content);
	if (!head) { return undefined; }
	const fenceStart = content.indexOf(`${TEXT_FENCE}\n`);
	if (fenceStart === -1) { return undefined; }
	const textFrom = fenceStart + TEXT_FENCE.length + 1;
	const fenceEnd = content.indexOf('\n```', textFrom);
	if (fenceEnd === -1) { return undefined; }
	const text = content.slice(textFrom, fenceEnd);

	const requirements: Requirement[] = [];
	for (const line of content.slice(fenceEnd).split(/\r?\n/)) {
		const item = ITEM_RE.exec(line.trim());
		if (!item) { continue; }
		const [, mark, id, startRaw, endRaw, , waivedAt, waivedReason] = item;
		const start = Number(startRaw);
		const end = Number(endRaw);
		if (!(start >= 0 && end > start && end <= text.length)) { continue; }
		requirements.push({
			id,
			// Цитата ВОССТАНАВЛИВАЕТСЯ из текста, а не читается из строки списка: источник правды один.
			quote: text.slice(start, end),
			start,
			end,
			...(mark === 'x' && waivedReason
				? { waived: { by: 'user' as const, reason: waivedReason.trim(), at: Date.parse(`${waivedAt}T00:00:00Z`) || 0 } }
				: {}),
		});
	}
	return { id: head[1], text, createdAt: Number(head[2]), requirements };
}

/** Имя файла брифа рядом с планами: по нему его находят и план, и пайплайн. */
export const briefFileName = (id: string): string => `${id}.brief.md`;
