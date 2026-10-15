/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Каталог моделей распознавания речи живёт в наборе `.vibe` (`.vibe-defaults/voice/sttModels.jsonc`), а в сборку едет
 * сгенерированным модулем. Здесь две вещи: модуль и файл набора — один и тот же текст, и файл той версии и того состава,
 * что читает код. Незнакомое поле роняет тест: выросший контракт надо прочитать, а не пропустить
 * Файл читается через `fs`, поэтому тест живёт в `test/node/`
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { STT_MODELS_JSONC } from '../../common/voice/sttModels.generated.js';
import { parseSttModelsCatalog, stripJsonc } from '../../common/voice/sttModelsCatalog.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelEchoVectors.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

const FILE_FIELDS = ['archives', 'batch', 'profiles', 'sampleRate', 'version'];
const ARCHIVE_FIELDS = ['dir', 'files', 'id', 'license', 'sha256', 'sizeBytes', 'source', 'url'];
const MODEL_FIELDS = ['archive', 'decoder', 'encoder', 'joiner', 'kind', 'model', 'tokens'];
const PROFILE_FIELDS = ['final', 'streaming'];

suite('каталог моделей речи — набор .vibe и сборка', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const fromSet = readFileSync(join(REPO_ROOT, '.vibe-defaults', 'voice', 'sttModels.jsonc'), 'utf8').replace(/\r\n/g, '\n');

	test('модуль сборки — тот же текст, что файл набора: после правки набора нужен npm run gen:stt-models', () => {
		assert.strictEqual(STT_MODELS_JSONC, fromSet);
	});

	test('файл набора той версии и того состава, что читает код', () => {
		const catalog = JSON.parse(stripJsonc(fromSet)) as Record<string, any>;
		const keys = (items: readonly object[]) => [...new Set(items.flatMap(item => Object.keys(item)))].sort();
		const models = [...Object.values(catalog.profiles as Record<string, any>).flatMap(p => [p.streaming, p.final].filter(Boolean)), ...Object.values(catalog.batch as Record<string, any>)];
		assert.deepStrictEqual({
			problems: parseSttModelsCatalog(fromSet).problems,
			fileFields: Object.keys(catalog).sort(),
			archiveFields: keys(catalog.archives).filter(field => !ARCHIVE_FIELDS.includes(field)),
			modelFields: keys(models).filter(field => !MODEL_FIELDS.includes(field)),
			profileFields: keys(Object.values(catalog.profiles as Record<string, object>)).filter(field => !PROFILE_FIELDS.includes(field)),
		}, {
			problems: [],
			fileFields: FILE_FIELDS,
			archiveFields: [],
			modelFields: [],
			profileFields: [],
		});
	});
});
