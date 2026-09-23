/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Таблицы `docs/manuals/slopSpec.md` против каталога, вшитого в сборку.
 *
 * По таблице правил модель собирает `.vibe/slop.json` («выключи RU-D1»), по таблице весов человек понимает счёт.
 * Правило, добавленное в каталог без строки, спека не назовёт, а переименованное назовёт по-старому, — и узнает об
 * этом тот, кто выключил несуществующий id. Файл читается через `fs`, поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SLOP_CATALOG_JSONC } from '../../common/slopCatalog.generated.js';
import { parseSlopCatalog, SLOP_SEVERITIES } from '../../common/textSlop/slopCatalog.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в subscriptionQuotaVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

suite('slopSpec — таблицы спеки совпадают с каталогом сборки', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('каждое правило каталога — строкой с тем же языком, весом и именем; веса и потолки — те, что считает детектор', () => {
		const spec = readFileSync(join(REPO_ROOT, 'docs', 'manuals', 'slopSpec.md'), 'utf8');
		const catalog = parseSlopCatalog(SLOP_CATALOG_JSONC, () => { });
		assert.ok(catalog, 'the shipped catalogue does not parse');
		const scoring = catalog.scoring;
		const rows = (pattern: RegExp) => [...spec.matchAll(pattern)].map(match => Object.values(match.groups!).map(cell => cell.trim()).join(' | '));
		assert.deepStrictEqual({
			count: /^Всего правил: (?<count>\d+)\.$/m.exec(spec)?.groups?.count,
			rules: rows(/^\| `(?<id>[A-Z0-9-]+)` \| (?<lang>[^|]+) \| `(?<severity>[a-z]+)` \| (?<name>[^|]+) \|$/gm),
			weights: rows(/^\| `(?<severity>note|minor|major|blocker)` \| (?<first>[\d.]+) \| (?<repeat>[\d.]+) \| (?<cap>[\d.]+) \|$/gm),
		}, {
			count: String(catalog.rules.length),
			rules: catalog.rules.map(rule => `${rule.id} | ${rule.lang === 'any' ? 'любой' : rule.lang} | ${rule.severity} | ${rule.name}`),
			weights: SLOP_SEVERITIES.map(severity => [
				severity,
				scoring.severityPoints[severity],
				scoring.repeatPoints[severity],
				scoring.severityPoints[severity] * scoring.ruleCapMultiplier,
			].join(' | ')),
		});
	});
});
