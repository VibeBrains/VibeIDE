/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Проверка НАСТОЯЩЕГО каталога `resources/model-quirks.json`.
 *
 * Раньше эта сюита жила рядом с тестами матчера и держала список правил **переписанным руками**, с
 * пометкой «kept in sync with the JSON catalog». Копия закономерно разошлась: правки каталога
 * уходили в релиз, а сюита оставалась зелёной, потому что проверяла вчерашний слепок.
 *
 * Первая попытка исправить это читала каталог через `loadBundledCatalog()` — динамический импорт с
 * атрибутом `with { type: 'json' }`. Локально работало, а в CI сломалось:
 * `ERR_IMPORT_ATTRIBUTE_MISSING`. Тамошняя быстрая транспиляция срезает import-атрибут (та же
 * грабля, из-за которой dev-запуск требует полной компиляции, а не `transpile`).
 *
 * Поэтому файл читается через `fs` — и тест живёт в `test/node/`, где это законно. Каталог всё
 * равно проверяется настоящий, но путь загрузки больше не зависит от того, как собрали тесты.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { matchQuirks, validateCatalog, ResolvedModelQuirks } from '../../common/modelQuirks/modelQuirksTypes.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/`. */
// `fileURLToPath` даёт путь к самому файлу, поэтому первый `..` — это каталог `node/`, а дальше
// семь уровней до корня: test → vibeide → contrib → workbench → vs → out → репозиторий.
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

suite('ModelQuirks — настоящий каталог resources/model-quirks.json', () => {

	const catalog = validateCatalog(JSON.parse(readFileSync(join(REPO_ROOT, 'resources', 'model-quirks.json'), 'utf8')));

	const cases: Array<[string, ResolvedModelQuirks | null]> = [
		// Семейное правило несёт ТОЛЬКО сэмплинг. Раньше оно форсило XML и молча перекрывало явный
		// `toolFormat: "openai"`, объявленный поставляемыми пресетами для поколения qwen3.
		['qwen3.6-plus', { temperature: 0.55, topP: 1.0 }],
		['qwen2.5-coder', { temperature: 0.55, topP: 1.0, forceToolCallFormat: 'xml' }],
		['qwen3.8-max', { temperature: 0.6, topP: 0.95, topK: 20 }],
		['ling-3.0-flash', { temperature: 0.6, topP: 0.95, topK: 20 }],
		// A call written as text is read for every model with native tools, not by a quirk
		// The catalogue leaves the flag unset
		['deepseek-v4-pro', { forceEmptyReasoning: true, mirrorReasoningContent: true, toolCallsInText: undefined, forcedToolChoiceUnsupported: true }],
		['deepseek-flash', { forceEmptyReasoning: true, mirrorReasoningContent: true, toolCallsInText: undefined, forcedToolChoiceUnsupported: true }],
		['kimi-k2.6', { temperature: 1.0, topP: 0.95, mirrorReasoningContent: true }],
		// K3 — preserved-thinking-history: наследует зеркалирование, а не общий пресет `kimi`.
		['kimi-k3', { temperature: 1.0, topP: 0.95, mirrorReasoningContent: true }],
		// K2.7 Code used to fall onto the legacy 'kimi-k2' rule (T=0.6, no mirror) because it is longer than 'kimi'.
		['kimi-k2.7-code', { temperature: 1.0, topP: 0.95, mirrorReasoningContent: true }],
		['kimi-k2.7-code-highspeed', { temperature: 1.0, topP: 0.95, mirrorReasoningContent: true }],
		['kimi-for-coding', { temperature: 1.0, topP: 0.95, mirrorReasoningContent: true }],
		['kimi-k2', { temperature: 0.6 }],
		['minimax-m2.7', { temperature: 1.0, topP: 0.95, topK: 40 }],
		// M3.1 sends reasoning in its own field, not in <think> tags like the rest of the family; thinks adaptively
		['minimax-m3.1-flash-preview', { mirrorReasoningContent: true, reasoningAsThinkTags: false, adaptiveThinking: true, forcedToolChoiceUnsupported: true }],
		['minimax-m3', { mirrorReasoningContent: true, reasoningAsThinkTags: true }],
		['glm-5.1', { temperature: 1.0 }],
		// Сэмплинг скоуплен на поколения, которые его ещё уважают: Google объявил
		// temperature/top_p/top_k устаревшими, поэтому Gemini 3.x не должен совпасть ни с чем.
		['gemini-2.5-pro', { temperature: 1.0, topP: 0.95, topK: 64 }],
		['gemini-1.5-pro', { temperature: 1.0, topP: 0.95, topK: 64 }],
		// Gemini 3 signs its reasoning and wants the signature back with the tool call (rule added 15.09.2026).
		['gemini-3.6-flash', { roundtripThoughtSignature: true }],
		['gemini-3-pro-preview', { roundtripThoughtSignature: true }],
		['mimo-v2-pro', null],
		['hy3-preview', null],
		// Claude 5 thinks in the adaptive mode; a compatible route (OpenCode Zen) learns it from the catalogue (25.09.2026)
		['claude-sonnet-5', { adaptiveThinking: true }],
		// Sonnet 5.5 (28.09.2026): forced tool_choice answers 400, reasoning bound to the model and the account
		['claude-sonnet-5-5', { adaptiveThinking: true, forcedToolChoiceUnsupported: true, reasoningBoundToModel: true }],
		// Haiku 5.5 (07.10.2026): adaptive, reasoning bound to the account; forced tool_choice is accepted
		['claude-haiku-5-5', { adaptiveThinking: true, reasoningBoundToModel: true, forcedToolChoiceUnsupported: undefined }],
		['claude-opus-4-7', { adaptiveThinking: true }],
		// 4.6 takes the adaptive mode; its token budget is deprecated, and sampling is not refused outright (08.10.2026)
		['claude-opus-4-6', { adaptiveThinking: true }],
		['claude-sonnet-4-6', { adaptiveThinking: true }],
		// GPT-6 changes its effort mid-thread by an update item; the pro models answer on Responses only (08.10.2026)
		['gpt-6.1-sol', { effortByUpdate: true }],
		['o3-pro', { responsesOnly: true }],
		['gpt-5-pro', { responsesOnly: true }],
	];

	for (const [modelId, expected] of cases) {
		test(`${modelId} → ожидаемые квирки`, () => {
			const q = matchQuirks(catalog.rules, modelId);
			if (expected === null) {
				assert.strictEqual(q, null);
				return;
			}
			assert.ok(q, `нет совпадения для ${modelId}`);
			const resolved: Record<string, unknown> = q;
			for (const [k, v] of Object.entries(expected)) {
				assert.strictEqual(resolved[k], v, `поле ${k} не совпало для ${modelId}`);
			}
		});
	}
});
