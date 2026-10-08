/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isClaudeModelId, thinkingBlockReplay, withoutEmptyThinkingSignatures } from '../../common/wireReasoning.js';

/**
 * Past thinking on the Anthropic wire: Claude gets its signed blocks, Kimi, MiMo and DeepSeek get every block,
 * and an unsigned block leaves without the empty signature the SDK needed to let it through — VibeIDEA's shape
 */
suite('thinkingReplay — чьё рассуждение уходит обратно на проводе Anthropic', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('подписанное — Claude и моделям с возвратом, неподписанное — только им, прочим — ничего', () => {
		const requester = { provider: 'p', model: 'm' };
		const echo = { echoReasoning: true, claude: false, requester };
		const claude = { echoReasoning: false, claude: true, requester };
		const other = { echoReasoning: false, claude: false, requester };
		const replay = (signed: boolean, target: typeof echo) => thinkingBlockReplay({ signed }, target);
		assert.deepStrictEqual([
			[replay(true, echo), replay(false, echo)],
			[replay(true, claude), replay(false, claude)],
			[replay(true, other), replay(false, other)],
		], [['asStreamed', 'asStreamed'], ['asStreamed', 'none'], ['none', 'none']]);
		assert.deepStrictEqual(['claude-opus-5-5', 'anthropic/Claude-Sonnet-5', 'kimi-k3'].map(isClaudeModelId), [true, true, false]);
	});

	test('подпись читает только её вендор: модель сменили посреди треда', () => {
		const claude = { echoReasoning: false, claude: true, requester: { provider: 'anthropic', model: 'claude-opus-5-5' } };
		const kimi = { echoReasoning: true, claude: false, requester: { provider: 'moonshot', model: 'kimi-k3' } };
		const byMiniMax = { provider: 'minimax', model: 'minimax-m3' };
		const bySonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
		assert.deepStrictEqual([
			// Claude never gets another vendor's signature: Anthropic answers an unreadable one with a 400
			thinkingBlockReplay({ signed: true, producedBy: byMiniMax }, claude),
			// Another Claude drops a block it cannot use without an error, so it goes as streamed
			thinkingBlockReplay({ signed: true, producedBy: bySonnet }, claude),
			thinkingBlockReplay({ signed: false, producedBy: bySonnet }, claude),
			// A model that needs its reasoning back gets another producer's block as text, without the signature
			thinkingBlockReplay({ signed: true, producedBy: bySonnet }, kimi),
			// Its own block, and a block from a thread older than the field, go back as they streamed
			thinkingBlockReplay({ signed: true, producedBy: claude.requester }, claude),
			thinkingBlockReplay({ signed: true }, claude),
		], ['none', 'asStreamed', 'none', 'asText', 'asStreamed', 'asStreamed']);
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
