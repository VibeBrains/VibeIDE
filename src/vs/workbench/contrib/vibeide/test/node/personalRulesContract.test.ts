/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Личный слой правил — контракт путей из набора (`.vibe-defaults/docs/personalRules.json`).
 *
 * Пути заданы в одном месте на всё семейство: VibeMemory пишет личные правила, VibeIDE и VibeIDEA
 * читают. Продукт берёт их из манифеста, куда контракт встраивает генератор, — тест ловит манифест,
 * который не перегенерировали после правки набора. Файл набора читается через `fs`, поэтому тест в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PERSONAL_AGENTS_FILE_PATH, PERSONAL_RULES_DIR_PATH, PROJECT_LOCAL_AGENTS_FILE_NAME, homeRelativeOf } from '../../common/personalRulesPaths.js';
import { VIBE_PERSONAL_RULES_CONTRACT, VibePersonalRulesContract } from '../../common/vibeDefaultsManifest.generated.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в mcpServersFileVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

suite('VibeIDE — контракт путей личных правил', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('манифест несёт контракт из .vibe-defaults/docs/personalRules.json, а пути выводятся из него', () => {
		const contract: VibePersonalRulesContract = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'docs', 'personalRules.json'), 'utf8'));

		assert.deepStrictEqual({
			embedded: VIBE_PERSONAL_RULES_CONTRACT,
			paths: [PERSONAL_AGENTS_FILE_PATH, PERSONAL_RULES_DIR_PATH, PROJECT_LOCAL_AGENTS_FILE_NAME, homeRelativeOf('AGENTS.local.md')],
		}, {
			embedded: {
				personalAgentsFile: contract.personalAgentsFile,
				personalRulesDir: contract.personalRulesDir,
				personalSkillsDir: contract.personalSkillsDir,
				projectLocalAgentsFile: contract.projectLocalAgentsFile,
			},
			paths: ['.vibe/AGENTS.md', '.vibe/rules', 'AGENTS.local.md', 'AGENTS.local.md'],
		});
	});
});
