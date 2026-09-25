/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isClaudeModelId, replaysThinkingBlock, withoutEmptyThinkingSignatures } from '../../common/wireReasoning.js';

/**
 * Past thinking on the Anthropic wire: Claude gets its signed blocks, Kimi, MiMo and DeepSeek get every block,
 * and an unsigned block leaves without the empty signature the SDK needed to let it through — VibeIDEA's shape
 */
suite('thinkingReplay — чьё рассуждение уходит обратно на проводе Anthropic', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('подписанное — Claude и моделям с возвратом, неподписанное — только им, прочим — ничего', () => {
		const echo = { echoReasoning: true, claude: false };
		const claude = { echoReasoning: false, claude: true };
		const other = { echoReasoning: false, claude: false };
		assert.deepStrictEqual([
			[replaysThinkingBlock(true, echo), replaysThinkingBlock(false, echo)],
			[replaysThinkingBlock(true, claude), replaysThinkingBlock(false, claude)],
			[replaysThinkingBlock(true, other), replaysThinkingBlock(false, other)],
		], [[true, true], [true, false], [false, false]]);
		assert.deepStrictEqual(['claude-opus-5-5', 'anthropic/Claude-Sonnet-5', 'kimi-k3'].map(isClaudeModelId), [true, true, false]);
	});

	test('пустая подпись вырезается, настоящая и чужие поля остаются; не JSON — как есть', () => {
		const body = JSON.stringify({
			model: 'kimi-k3', messages: [
				{ role: 'user', content: 'x' },
				{ role: 'assistant', content: [{ type: 'thinking', thinking: 'a', signature: '' }, { type: 'thinking', thinking: 'b', signature: 's' }, { type: 'text', text: 't' }] },
			],
		});
		assert.deepStrictEqual(JSON.parse(withoutEmptyThinkingSignatures(body)).messages[1].content, [
			{ type: 'thinking', thinking: 'a' },
			{ type: 'thinking', thinking: 'b', signature: 's' },
			{ type: 'text', text: 't' },
		]);
		const untouched = JSON.stringify({ messages: [{ role: 'user', content: 'x' }] });
		assert.deepStrictEqual([withoutEmptyThinkingSignatures(untouched) === untouched, withoutEmptyThinkingSignatures('не json')], [true, 'не json']);
	});
});
