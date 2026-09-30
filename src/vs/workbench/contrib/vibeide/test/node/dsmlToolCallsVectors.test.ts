/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Вызов инструмента текстом в разметке DeepSeek — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/dsmlToolCalls.json`).
 *
 * Разбор один на оба продукта: иначе одна и та же разметка в одном продукте исполняется, а в другом читается
 * ответом, и разъезжается это молча. Векторы читаются через `fs`, поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseDsmlToolCalls } from '../../common/dsmlToolCalls.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelQuirksCatalog.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface DsmlCase {
	readonly name: string;
	readonly text: string;
	readonly markup: boolean;
	readonly parsed: boolean;
	readonly calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[];
	readonly answer: string;
}

/** Поля кейса по договору; незнакомое поле значит, что договор вырос, а тест об этом не знает */
const CASE_FIELDS = ['name', 'text', 'markup', 'parsed', 'calls', 'answer'];

suite('dsmlToolCalls — общие с VibeIDEA векторы разбора вызова текстом', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: { readonly version: number; readonly cases: readonly DsmlCase[] } = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'dsmlToolCalls.json'), 'utf8'));

	test('договор векторов — первая версия, у кейсов только известные поля', () => {
		assert.deepStrictEqual(
			{ version: vectors.version, unknownFields: vectors.cases.flatMap(c => Object.keys(c).filter(key => !CASE_FIELDS.includes(key))) },
			{ version: 1, unknownFields: [] },
		);
	});

	test('каждый кейс разбирается так же, как у VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.cases.map(c => ({ name: c.name, ...parseDsmlToolCalls(c.text) })),
			vectors.cases.map(c => ({ name: c.name, markup: c.markup, parsed: c.parsed, calls: c.calls, answer: c.answer })),
		);
	});
});
