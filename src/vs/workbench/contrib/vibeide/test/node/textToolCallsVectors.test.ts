/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Вызов инструмента, написанный текстом разметкой любого семейства
 * Векторы общие с VibeIDEA: `.vibe-defaults/testVectors/textToolCalls.json`
 *
 * Разбор один на оба продукта: иначе одна и та же разметка в одном продукте исполняется, а в другом читается ответом
 * И разъезжается это молча
 * Поток режется по одному символу: открывающий тег, разрезанный между кусками, — обычный случай, а не редкий
 * Векторы читаются через `fs`, поэтому тест живёт в `test/node/`
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { OfferedToolSchemas, parseTextToolCalls, textToolCallStart, TextToolCallsOutcome, TextToolMarkupFilter } from '../../common/textToolCalls.js';
import { JsonObject, TEXT_TOOL_CALL_FORMATS } from '../../common/textToolCallFormats.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelQuirksCatalog.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface TextToolCallCase {
	readonly name: string;
	readonly format: string | null;
	readonly text: string;
	readonly outcome: TextToolCallsOutcome;
	readonly calls: readonly { readonly name: string; readonly arguments: JsonObject }[];
	readonly answer: string;
}

interface TextToolCallVectors {
	readonly version: number;
	readonly tools: OfferedToolSchemas;
	readonly cases: readonly TextToolCallCase[];
}

/** Поля файла и кейса по договору; незнакомое поле значит, что договор вырос, а тест об этом не знает */
const FILE_FIELDS = ['_comment', 'version', 'tools', 'cases'];
const CASE_FIELDS = ['name', 'format', 'text', 'outcome', 'calls', 'answer'];

/** Меньше — значит векторы потерялись при переносе набора */
const MIN_CASES = 30;

suite('textToolCalls — общие с VibeIDEA векторы вызова, написанного текстом', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const raw: Record<string, unknown> = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'textToolCalls.json'), 'utf8'));
	const vectors = raw as unknown as TextToolCallVectors;

	test('договор векторов — первая версия, только известные поля, у каждой формы свои кейсы и чужих нет', () => {
		assert.deepStrictEqual({
			version: vectors.version,
			enoughCases: vectors.cases.length >= MIN_CASES,
			unknownFileFields: Object.keys(raw).filter(key => !FILE_FIELDS.includes(key)),
			unknownCaseFields: vectors.cases.flatMap(c => Object.keys(c).filter(key => !CASE_FIELDS.includes(key)).map(key => `${c.name}: ${key}`)),
			formats: [...new Set(vectors.cases.map(c => c.format).filter(format => format !== null))].sort(),
		}, {
			version: 1,
			enoughCases: true,
			unknownFileFields: [],
			unknownCaseFields: [],
			formats: TEXT_TOOL_CALL_FORMATS.map(format => format.id).sort(),
		});
	});

	test('каждый кейс читается в тот же исход, вызовы и ответ, что у VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.cases.map(c => ({ name: c.name, ...parseTextToolCalls(c.text, vectors.tools) })),
			vectors.cases.map(c => ({ name: c.name, outcome: c.outcome, calls: c.calls, answer: c.answer, format: c.format })),
		);
	});

	test('по одному символу: разметка не доходит до показа, ответ не теряется и не задерживается', () => {
		const streamed = (c: TextToolCallCase) => {
			const filter = new TextToolMarkupFilter();
			let monotonic = true;
			// UTF-16 units, as a stream cuts them: a chunk may end inside a surrogate pair
			for (let i = 0; i < c.text.length; i++) {
				const before = filter.shown;
				filter.accept(c.text[i]);
				monotonic &&= filter.shown.startsWith(before);
			}
			const held = filter.finish();
			return {
				name: c.name,
				monotonic,
				// What was shown plus what was held is the whole answer, nothing lost and nothing twice
				whole: filter.shown + (held ?? '') === c.text,
				held: held !== undefined,
				markupShown: textToolCallStart(filter.shown) >= 0,
				heldReads: held === undefined ? undefined : parseTextToolCalls(held, vectors.tools).outcome,
			};
		};
		assert.deepStrictEqual(vectors.cases.map(streamed), vectors.cases.map(c => ({
			name: c.name,
			monotonic: true,
			whole: true,
			held: c.format !== null,
			markupShown: false,
			heldReads: c.format === null ? undefined : c.outcome,
		})));
	});
});
