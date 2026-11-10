/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolApprovalType } from '../../toolsServiceTypes.js';
import { builtinToolDefs } from './index.js';

/** Строка таблицы: имя, категория согласия, первая строка описания */
export type ToolsDocRow = {
	readonly name: string;
	readonly approval: string;
	readonly summary: string;
};

/** Что нужно от определения инструмента для таблицы */
type DocToolDef = {
	readonly name: string;
	readonly description: string;
	readonly approvalType?: ToolApprovalType;
};

/** Пустая категория согласия означает «только чтение» */
const approvalLabel = (approvalType?: ToolApprovalType): string => approvalType ?? 'чтение';

/** В таблицу влезает только первая строка описания */
const firstLine = (description: string): string => description.split(/\r?\n/, 1)[0].trim();

/** Символ `|` ломает ячейку таблицы, поэтому экранируется */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

/** Строки в порядке реестра: порядок задаёт реестр, а не сортировка */
export function toolsDocRows(defs: Readonly<Record<string, DocToolDef>> = builtinToolDefs): ToolsDocRow[] {
	return Object.keys(defs).map(name => {
		const def = defs[name];
		return { name, approval: approvalLabel(def.approvalType), summary: firstLine(def.description) };
	});
}

/** Markdown-таблица инструментов агента; шапка запрещает править файл руками */
export function renderToolsDocMarkdown(defs: Readonly<Record<string, DocToolDef>> = builtinToolDefs): string {
	const rows = toolsDocRows(defs);
	return [
		'<!-- Файл генерируется scripts/vibe-tools-doc.ts — не править руками -->',
		'',
		'# Инструменты агента',
		'',
		`Всего: ${rows.length}. Порядок — как в реестре \`src/vs/workbench/contrib/vibeide/common/prompt/tools/index.ts\`.`,
		'',
		'| Инструмент | Согласие | Описание |',
		'| --- | --- | --- |',
		...rows.map(row => `| \`${row.name}\` | ${row.approval} | ${cell(row.summary)} |`),
		'',
	].join('\n');
}
