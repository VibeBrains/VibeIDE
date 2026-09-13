/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { orchestrationTokensOfTail, orchestrationTokensOfUsage, withOrchestration } from '../../common/orchestrationUsage.js';

/**
 * Токены оркестратора биллятся сверх видимых и в нормализованный usage не попадают.
 * Правила чтения — как у VibeIDEA, чтобы оба продукта считали один ход одинаково.
 */
suite('orchestrationUsage — счёт оркестратора сверх видимых токенов', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const flat = { prompt_tokens: 100, completion_tokens: 50, orchestration_input_tokens: 1200, orchestration_output_tokens: 300, orchestration_input_cached_tokens: 200 };
	const nested = { prompt_tokens: 100, completion_tokens: 50, token_details: { orchestration_input_tokens: 900, orchestration_output_tokens: 90, orchestration_input_cached_tokens: 0 } };

	test('плоская и вложенная формы читаются; при обеих побеждает вложенная, без сложения', () => {
		assert.deepStrictEqual(
			[
				orchestrationTokensOfUsage(flat),
				orchestrationTokensOfUsage(nested),
				orchestrationTokensOfUsage({ ...flat, token_details: nested.token_details }),
			],
			[
				{ input: 1200, output: 300, cachedInput: 200 },
				{ input: 900, output: 90, cachedInput: 0 },
				{ input: 900, output: 90, cachedInput: 0 },
			],
		);
	});

	test('обычный ответ без оркестрации ничего не добавляет', () => {
		assert.deepStrictEqual(
			[orchestrationTokensOfUsage({ prompt_tokens: 10, completion_tokens: 5 }), orchestrationTokensOfUsage(undefined), withOrchestration({ promptTokens: 10 }, undefined)],
			[undefined, undefined, { promptTokens: 10 }],
		);
	});

	test('из хвоста стрима берётся последний usage, обрезанная строка пропускается', () => {
		const tail = [
			'data: {"choices":[{"delta":{"content":"ok"}}]}',
			`data: {"usage":${JSON.stringify(flat)}}`,
			'data: [DONE]',
			'data: {"usage":{"orchestration_input_tok',
		].join('\n');
		assert.deepStrictEqual(orchestrationTokensOfTail(tail), { input: 1200, output: 300, cachedInput: 200 });
	});

	test('к счёту SDK добавляются вход, кэш и выход оркестрации', () => {
		assert.deepStrictEqual(
			withOrchestration({ promptTokens: 100, completionTokens: 50, cachedInputTokens: 10, totalTokens: 150 }, { input: 1200, output: 300, cachedInput: 200 }),
			{ promptTokens: 1300, completionTokens: 350, cachedInputTokens: 210, totalTokens: 1650 },
		);
	});
});
