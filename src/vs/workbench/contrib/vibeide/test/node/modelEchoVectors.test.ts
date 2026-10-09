/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Сверка «просили → ответила» обязана читать один и тот же ответ одинаково в обоих продуктах
 * Общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/modelEcho.json`) говорят, где подмена, а где та же модель
 * Ручной порт без общих векторов уже разъехался: плавающий алиас у VibeIDEA не тревожил, у нас — на каждом ходу
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
import { isModelSubstituted, quirkModelOf } from '../../common/modelEcho.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelRoutersVectors.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

const FILE_FIELDS = ['_comment', 'cases', 'version'];
const CASE_FIELDS = ['answered', 'asked', 'quirkModel', 'substituted', 'why'];
const READ_VERSION = 1;

interface ModelEchoCase {
	readonly asked: string;
	readonly answered: string | null;
	readonly substituted: boolean;
	/** The id quirk rules are matched against */
	readonly quirkModel: string;
	readonly why: string;
}

interface ModelEchoVectors {
	readonly version: number;
	readonly cases: readonly ModelEchoCase[];
}

suite('modelEcho — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const raw: Record<string, unknown> = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'modelEcho.json'), 'utf8'));
	const vectors = raw as unknown as ModelEchoVectors;

	test('файл той версии и того состава, что читает этот тест', () => {
		assert.deepStrictEqual(
			{ version: vectors.version, fileFields: Object.keys(raw).sort(), caseFields: [...new Set(vectors.cases.flatMap(c => Object.keys(c)))].sort() },
			{ version: READ_VERSION, fileFields: FILE_FIELDS, caseFields: CASE_FIELDS },
		);
	});

	test('подмена — только другая модель, и причуды ищутся по той же сборке, что у VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.cases.map(c => ({ why: c.why, substituted: isModelSubstituted(c.asked, c.answered ?? undefined), quirkModel: quirkModelOf(c.asked, c.answered ?? undefined) })),
			vectors.cases.map(c => ({ why: c.why, substituted: c.substituted, quirkModel: c.quirkModel })),
		);
	});
});
