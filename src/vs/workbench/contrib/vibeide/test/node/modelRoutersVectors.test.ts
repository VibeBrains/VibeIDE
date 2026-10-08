/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Модель-роутер отвечает выбранной им моделью, и оба продукта обязаны читать это одинаково
 * Общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/modelRouters.json`) называют, кто ответил,
 * подмена ли это и по какой записи каталога считается цена
 *
 * Незнакомое поле роняет тест: выросший контракт надо прочитать, а не пропустить
 * Файл читается через `fs`, поэтому тест живёт в `test/node/`
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { billedModelOf, isModelSubstituted } from '../../common/modelEcho.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в providerAuthVectors.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

const FILE_FIELDS = ['_comment', 'cases', 'version'];
const CASE_FIELDS = ['answered', 'asked', 'billed', 'body', 'catalogue', 'header', 'substituted'];
const READ_VERSION = 1;

interface ModelRouterCase {
	readonly asked: string;
	readonly header: string | null;
	readonly body: string | null;
	readonly catalogue: readonly string[];
	readonly answered: string | null;
	readonly substituted: boolean;
	readonly billed: string;
}

interface ModelRouterVectors {
	readonly version: number;
	readonly cases: readonly ModelRouterCase[];
}

suite('modelRouters — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const raw: Record<string, unknown> = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'modelRouters.json'), 'utf8'));
	const vectors = raw as unknown as ModelRouterVectors;

	test('файл той версии и того состава, что читает этот тест', () => {
		assert.deepStrictEqual(
			{ version: vectors.version, fileFields: Object.keys(raw).sort(), caseFields: [...new Set(vectors.cases.flatMap(c => Object.keys(c)))].sort() },
			{ version: READ_VERSION, fileFields: FILE_FIELDS, caseFields: CASE_FIELDS },
		);
	});

	test('кто ответил, подмена ли и запись цены — как в VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.cases.map(c => {
				// The header wins over the body, as the adapter reads `cf-aig-routed-model` before the answer's head
				const answered = c.header ?? c.body ?? undefined;
				return {
					asked: c.asked,
					answered: answered ?? null,
					substituted: isModelSubstituted(c.asked, answered),
					billed: billedModelOf(c.asked, answered, c.catalogue),
				};
			}),
			vectors.cases.map(c => ({ asked: c.asked, answered: c.answered, substituted: c.substituted, billed: c.billed })),
		);
	});
});
