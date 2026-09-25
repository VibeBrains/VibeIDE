/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compatibleClaudeThinkingOptions } from '../../common/wireReasoning.js';

/** Thinking on the Anthropic wire for a route that is not Anthropic's own: the spelling follows the model, as in VibeIDEA */
suite('compatibleClaudeThinkingOptions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adaptive for a Claude 5 model, a budget by position for the rest, nothing when reasoning is off', () => {
		const words = ['low', 'medium', 'high'];
		const effort = (reasoningEffort: string) => ({ type: 'effort_slider_value' as const, isReasoningEnabled: true as const, reasoningEffort });
		assert.deepStrictEqual([
			compatibleClaudeThinkingOptions(effort('medium'), 'summarized', true, words),
			compatibleClaudeThinkingOptions({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 5000 }, 'summarized', true, undefined),
			compatibleClaudeThinkingOptions(effort('low'), 'summarized', false, words),
			compatibleClaudeThinkingOptions(effort('medium'), 'summarized', false, words),
			compatibleClaudeThinkingOptions(effort('max'), 'summarized', false, ['low', 'high', 'max']),
			compatibleClaudeThinkingOptions({ type: 'budget_slider_value', isReasoningEnabled: true, reasoningBudget: 5000 }, 'summarized', false, undefined),
			compatibleClaudeThinkingOptions(null, 'summarized', false, words),
		], [
			{ thinking: { type: 'adaptive', display: 'summarized' }, effort: 'medium' },
			{ thinking: { type: 'adaptive', display: 'summarized' } },
			{ thinking: { type: 'enabled', budgetTokens: 2000 } },
			{ thinking: { type: 'enabled', budgetTokens: 8000 } },
			{ thinking: { type: 'enabled', budgetTokens: 24000 } },
			{ thinking: { type: 'enabled', budgetTokens: 5000 } },
			{},
		]);
	});
});
