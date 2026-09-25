/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Возврат рассуждения — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/reasoningEcho.json`).
 *
 * Какая модель требует своё рассуждение обратно и в какой форме, решает вендор, а не продукт: список в двух
 * продуктах разъезжается молча, и расплата — 400 на втором раунде инструментов. Векторы читаются вместе с настоящим
 * каталогом `resources/model-quirks.json` через `fs`, поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { matchQuirks, validateCatalog } from '../../common/modelQuirks/modelQuirksTypes.js';
import { isClaudeModelId } from '../../common/wireReasoning.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelQuirksCatalog.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

type OpenAIEcho = 'reasoning_content' | 'think-tags' | null;
type AnthropicEcho = 'all' | 'same-prefix' | 'none';

interface ReasoningEchoCase {
	readonly model: string;
	readonly openai: OpenAIEcho;
	readonly anthropic: AnthropicEcho;
}

suite('reasoningEcho — общие с VibeIDEA векторы возврата рассуждения', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: { readonly cases: readonly ReasoningEchoCase[] } = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'reasoningEcho.json'), 'utf8'));
	const catalog = validateCatalog(JSON.parse(readFileSync(join(REPO_ROOT, 'resources', 'model-quirks.json'), 'utf8')));

	/** What our adapter does for the model, in the vectors' terms (`aiSdkAdapter.convertMessagesToModelMessages`) */
	function echoOf(model: string): ReasoningEchoCase {
		const quirks = matchQuirks(catalog.rules, model) ?? {};
		const echo = quirks.mirrorReasoningContent === true;
		return {
			model,
			openai: echo ? (quirks.reasoningAsThinkTags === true ? 'think-tags' : 'reasoning_content') : null,
			anthropic: echo ? 'all' : isClaudeModelId(model) ? 'same-prefix' : 'none',
		};
	}

	test('каждая модель возвращает рассуждение в той же форме, что у VibeIDEA', () => {
		assert.deepStrictEqual(vectors.cases.map(c => echoOf(c.model)), vectors.cases.map(c => ({ model: c.model, openai: c.openai, anthropic: c.anthropic })));
	});
});
