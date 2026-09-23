/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { claudeThinkingDisplayOf, claudeThinkingOptions, googleThinkingConfig, openAIReasoningEffort } from '../../common/wireReasoning.js';

/**
 * Один выбор рассуждения — три написания на проводе. Проверяется то, что уйдёт в опции SDK, и то,
 * чего уйти не должно: значение, которого провод не знает, превращается в умолчание вендора, а не в 400.
 */
suite('wireReasoning — выбор рассуждения по проводам', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Claude: уровень — adaptive с показом, бюджет — enabled, выключено — ничего, привязка — drop_block', () => {
		assert.deepStrictEqual([
			claudeThinkingOptions({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'xhigh' }, 'summarized', false),
			claudeThinkingOptions({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'max' }, 'updates', true),
			claudeThinkingOptions({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'turbo' }, 'omitted', false),
			claudeThinkingOptions({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 4096 }, 'summarized', true),
			claudeThinkingOptions(null, 'summarized', false),
			claudeThinkingOptions(null, 'summarized', true),
		], [
			{ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'xhigh' },
			{ thinking: { type: 'adaptive', display: 'updates', blockBinding: { prefixMismatchBehavior: 'drop_block' } }, effort: 'max' },
			// Незнакомый уровень не уходит: у вендора умолчание, а не отказ.
			{ thinking: { type: 'adaptive', display: 'omitted' } },
			{ thinking: { type: 'enabled', budgetTokens: 4096 } },
			{},
			{ thinking: { blockBinding: { prefixMismatchBehavior: 'drop_block' } } },
		]);
	});

	test('OpenAI: уровень уходит как есть, «выключено» — значением модели или ничем', () => {
		assert.deepStrictEqual([
			openAIReasoningEffort({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'high' }, false, 'none'),
			openAIReasoningEffort(null, true, 'none'),
			openAIReasoningEffort(null, true, undefined),
			openAIReasoningEffort(null, false, 'none'),
		], ['high', 'none', undefined, undefined]);
	});

	test('Gemini: бюджет — thinkingBudget, уровень — thinkingLevel, незнакомый уровень — ничего', () => {
		assert.deepStrictEqual([
			googleThinkingConfig({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 2048 }),
			googleThinkingConfig({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'High' }),
			googleThinkingConfig({ type: 'effort_slider_value', isReasoningEnabled: true, reasoningEffort: 'xhigh' }),
			googleThinkingConfig(null),
		], [{ thinkingBudget: 2048 }, { thinkingLevel: 'high' }, undefined, undefined]);
	});

	test('настройка показа мышления: опечатка в руками правленом значении не доходит до вендора', () => {
		assert.deepStrictEqual(
			['summarized', 'updates', 'omitted', 'summary', undefined, 42].map(claudeThinkingDisplayOf),
			['summarized', 'updates', 'omitted', 'summarized', 'summarized', 'summarized'],
		);
	});
});
