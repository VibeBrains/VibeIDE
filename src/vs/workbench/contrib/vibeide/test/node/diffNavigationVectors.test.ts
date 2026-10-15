/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Какая правка становится текущей после решения прежней, обязано читаться одинаково в обоих продуктах
 * Общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/diffNavigation.json`) называют место решённой правки и сколько их осталось
 * Новый случай заводится в векторы, а не в тест одной стороны
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
import { diffIdxAfterResolve } from '../../common/diffNavigation.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelEchoVectors.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

const FILE_FIELDS = ['_comment', 'cases', 'version'];
const CASE_FIELDS = ['expected', 'newLength', 'resolvedIdx', 'why'];
const READ_VERSION = 1;

interface DiffNavigationCase {
	/** Where the resolved change stood in the list before the resolve */
	readonly resolvedIdx: number;
	/** How many changes are left after it */
	readonly newLength: number;
	readonly expected: number | null;
	readonly why: string;
}

interface DiffNavigationVectors {
	readonly version: number;
	readonly cases: readonly DiffNavigationCase[];
}

suite('diff navigation — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const raw: Record<string, unknown> = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'diffNavigation.json'), 'utf8'));
	const vectors = raw as unknown as DiffNavigationVectors;

	test('файл той версии и того состава, что читает этот тест', () => {
		assert.deepStrictEqual(
			{ version: vectors.version, fileFields: Object.keys(raw).sort(), caseFields: [...new Set(vectors.cases.flatMap(c => Object.keys(c)))].sort(), cases: vectors.cases.length > 0 },
			{ version: READ_VERSION, fileFields: FILE_FIELDS, caseFields: CASE_FIELDS, cases: true },
		);
	});

	test('после решения текущей становится та, что стояла следом, а после последней — предыдущая', () => {
		assert.deepStrictEqual(
			vectors.cases.map(c => ({ why: c.why, current: diffIdxAfterResolve(c.resolvedIdx, c.newLength) })),
			vectors.cases.map(c => ({ why: c.why, current: c.expected })),
		);
	});
});
