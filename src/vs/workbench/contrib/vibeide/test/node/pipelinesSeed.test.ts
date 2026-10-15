/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Засеваемый `.vibe-defaults/pipelines.json` читают оба продукта, и каждый пайплайн из него обязан загрузиться у нас
 * Поле, которого разбор не знал, молча пропускалось: `screen-from-brief` грузился, а его приёмка по брифу судила по пересказу
 * Файл читается через `fs`, поэтому тест живёт в `test/node/`
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parsePipelineFile } from '../../common/pipeline/vibePipelineFile.js';
import { isSubagentType, roleMayWrite } from '../../common/vibeSubagentService.js';
import { safeParseConfigJson } from '../../common/vibeConfigJsonParser.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelEchoVectors.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

suite('pipelines.json из набора — каждый пайплайн загружается разбором VibeIDE', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const text = readFileSync(join(REPO_ROOT, '.vibe-defaults', 'pipelines.json'), 'utf8');
	const read = safeParseConfigJson(text);
	const written = read.ok ? (read.value as { pipelines: { id: string }[] }).pipelines.map(p => p.id) : [];
	const loaded = read.ok ? parsePipelineFile(read.value, { isKnownRole: isSubagentType, roleMayWrite }) : undefined;

	test('ни один пайплайн не пропущен', () => {
		assert.deepStrictEqual(
			{ parsed: read.ok, loadedIds: loaded?.file.pipelines.map(p => p.id), skipped: loaded?.warnings.filter(w => w.includes('пропущен')) },
			{ parsed: true, loadedIds: written, skipped: [] },
		);
	});

	test('приёмка screen-from-brief сверяется с брифом, а не с рассказом шагов', () => {
		const acceptance = loaded?.file.pipelines.find(p => p.id === 'screen-from-brief')?.steps.at(-1);
		assert.deepStrictEqual({ role: acceptance?.role, againstBrief: acceptance?.againstBrief }, { role: 'critic', againstBrief: true });
	});
});
