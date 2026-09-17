/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Остаток подписки — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/subscriptionQuota.json`).
 *
 * Векторы лежат в VibeBrains, а не копией здесь: копия расходится молча, а общий файл падает сразу у того продукта,
 * который прочитал ответ вендора иначе. Файл читается через `fs`, поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { leftShare, parseSubscriptionQuota } from '../../common/subscriptionQuota.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelQuirksCatalog.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface QuotaVectors {
	readonly parse: readonly { readonly name: string; readonly format: string; readonly body: string; readonly expect: unknown }[];
	readonly leftShare: readonly { readonly count: number; readonly total: number; readonly remainingPercent: number | null; readonly expect: number | null }[];
}

suite('subscriptionQuota — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: QuotaVectors = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'subscriptionQuota.json'), 'utf8'));

	test('каждый ответ вендора читается так же, как в VibeIDEA', () => {
		assert.deepStrictEqual(
			vectors.parse.map(v => ({ name: v.name, result: parseSubscriptionQuota(v.format, v.body) })),
			vectors.parse.map(v => ({ name: v.name, result: v.expect })),
		);
	});

	test('доля остатка MiniMax: прочтение по проценту, иначе ничего', () => {
		const round = (value: number | null) => value === null ? null : Math.round(value * 1e9) / 1e9;
		assert.deepStrictEqual(
			vectors.leftShare.map(v => round(leftShare(v.count, v.total, v.remainingPercent))),
			vectors.leftShare.map(v => v.expect),
		);
	});
});
