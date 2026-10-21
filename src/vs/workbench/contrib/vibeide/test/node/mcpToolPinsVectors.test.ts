/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Отпечаток инструментов MCP — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/mcpToolPins.json`).
 *
 * Сервер может переписать описание уже одобренного инструмента, а описание доходит до модели слово в слово.
 * Поэтому одобренное определение сверяется с тем, что сервер отдал теперь: перестановка слов в `default` — не подмена
 * (сервер на Python отдаёт множество в другом порядке при каждом запуске), новое слово — подмена. Если два продукта
 * отвечают на один и тот же случай по-разному, сервер то молча работает, то требует одобрения заново — смотря в какой IDE открыт.
 * Продукты хранят определение по-разному (мы — текстом, VibeIDEA — хешем), векторам важен только ответ «то же / другое».
 * Файл читается через `fs`, поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { MCPTool } from '../../common/mcpServiceTypes.js';
import { diffToolDefinitions, toolDefinitionsOf, withheldToolsOf } from '../../common/mcpToolPins.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в mcpServersFileVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface PinCase {
	readonly name: string;
	readonly why: string;
	/** Определение, одобренное раньше. */
	readonly a: MCPTool;
	/** Определение, которое сервер отдал теперь. */
	readonly b: MCPTool;
	/** Должны ли они совпасть при сверке. */
	readonly same: boolean;
}

suite('mcpToolPins — общие с VibeIDEA векторы отпечатка инструментов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: { readonly cases: readonly PinCase[] } = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'mcpToolPins.json'), 'utf8'));

	/**
	 * Ответ нашей сверки в терминах векторов: инструмент не скрыт от модели (`withheldToolsOf`) — значит, «то же».
	 * Идёт тем же путём, что и в сервисе: определения снимаются `toolDefinitionsOf`, сравниваются `diffToolDefinitions`.
	 */
	function sameForUs(approved: MCPTool, offeredNow: MCPTool): boolean {
		return withheldToolsOf(diffToolDefinitions(toolDefinitionsOf([approved]), toolDefinitionsOf([offeredNow]))).size === 0;
	}

	test('векторы набора на месте и не пусты', () => {
		assert.ok(vectors.cases.length >= 19, `ожидалось не меньше 19 случаев, найдено ${vectors.cases.length}`);
		assert.deepStrictEqual(vectors.cases.filter(c => typeof c.same !== 'boolean' || !c.a || !c.b), []);
	});

	test('каждая пара определений даёт тот же ответ, что у VibeIDEA', () => {
		const disagreements = vectors.cases
			.filter(c => sameForUs(c.a, c.b) !== c.same)
			.map(c => `${c.name}: у нас ${sameForUs(c.a, c.b) ? 'то же' : 'другое'}, в векторах ${c.same ? 'то же' : 'другое'} (${c.why})`);
		assert.deepStrictEqual(disagreements, []);
	});

	test('сверка симметрична для «то же»: перестановка слов не подмена ни в одну сторону', () => {
		const asymmetric = vectors.cases.filter(c => c.same && !sameForUs(c.b, c.a)).map(c => c.name);
		assert.deepStrictEqual(asymmetric, []);
	});
});
