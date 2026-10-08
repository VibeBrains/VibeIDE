/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { anthropicEffortTurns, effortMarkOf, EffortTurn, planAnthropicEffortUpdates, planEffortUpdates, withAnthropicEffortUpdates, withConfigurationUpdates } from '../../common/effortUpdates.js';

/**
 * The effort moved mid-thread goes as an update in place, and the request keeps the thread's first effort
 * The cases are VibeIDEA's (`EffortUpdatesTest`): one thread must cost the same in both products
 */
suite('effortUpdates — смена уровня посреди разговора без сгоревшего кэша', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const key = 'openAI/gpt-6.1-sol';
	const user: EffortTurn = { role: 'user' };
	const answer = (effort: string, by = key): EffortTurn => ({ role: 'assistant', effortMark: effortMarkOf(by, effort) });

	test('свежий тред, сдвинутый ползунок, повтор прежних обновлений, ответы другой модели', () => {
		const plans = [
			planEffortUpdates([user], key, 'low'),
			planEffortUpdates([user, answer('low'), user], key, 'high'),
			planEffortUpdates([user, answer('low'), user, answer('high'), user, answer('high'), user], key, 'medium'),
			planEffortUpdates([user, answer('max', 'openAI/gpt-6-astra'), user], key, 'low'),
		];
		assert.deepStrictEqual(plans, [
			// A fresh thread sends its effort and no update
			{ requestEffort: 'low', updates: [], mark: 'openAI/gpt-6.1-sol#low' },
			// The request keeps the first effort, the update goes before the new question
			{ requestEffort: 'low', updates: [{ beforeUserMessage: 1, effort: 'high' }], mark: 'openAI/gpt-6.1-sol#high' },
			// Every earlier update is replayed at its place, the same on every later request
			{ requestEffort: 'low', updates: [{ beforeUserMessage: 1, effort: 'high' }, { beforeUserMessage: 3, effort: 'medium' }], mark: 'openAI/gpt-6.1-sol#medium' },
			// Answers of another model say nothing about this one
			{ requestEffort: 'low', updates: [], mark: 'openAI/gpt-6.1-sol#low' },
		]);
	});

	test('элемент встаёт перед n-м сообщением пользователя в input; прочие элементы не считаются', () => {
		const body = JSON.stringify({
			model: 'gpt-6.1-sol',
			reasoning: { effort: 'low' },
			input: [
				{ role: 'developer', content: 'system' },
				{ role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
				{ type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{}' },
				{ type: 'function_call_output', call_id: 'c1', output: 'a' },
				{ role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
				{ role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
			],
		});
		const sent = JSON.parse(withConfigurationUpdates(body, [{ beforeUserMessage: 1, effort: 'high' }]));
		assert.deepStrictEqual(
			{ effort: sent.reasoning.effort, input: sent.input.map((item: { role?: string; type?: string; reasoning?: unknown }) => item.role ?? (item.reasoning ? { type: item.type, reasoning: item.reasoning } : item.type)) },
			{ effort: 'low', input: ['developer', 'user', 'function_call', 'function_call_output', 'assistant', { type: 'configuration_update', reasoning: { effort: 'high' } }, 'user'] },
		);
		assert.deepStrictEqual([withConfigurationUpdates(body, []), withConfigurationUpdates('не JSON', [{ beforeUserMessage: 0, effort: 'high' }])], [body, 'не JSON']);
	});

	/**
	 * Claude on Anthropic's own API: the change is an effort-only system message, and tool results ride in user messages
	 * A user message the wire merges with tool results must directly follow the calls, so nothing can go before it
	 */
	test('провод Anthropic: результаты инструментов — не ход пользователя, склеенный ход откатывает план к уровню в запросе', () => {
		const claude = 'anthropic/claude-sonnet-5-5';
		const tool: EffortTurn = { role: 'tool' };
		const answered = (effort: string): EffortTurn => ({ role: 'assistant', effortMark: effortMarkOf(claude, effort) });
		const folded = anthropicEffortTurns([user, answered('low'), tool, answered('low'), user, answered('low'), tool, user]);
		assert.deepStrictEqual(
			{ roles: folded.turns.map(turn => turn.role), mixed: [...folded.mixedUserMessages] },
			{ roles: ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'user'], mixed: [2] },
		);
		assert.deepStrictEqual([
			// The change lands on an ordinary user message: an update before it, the request keeps low
			planAnthropicEffortUpdates([user, answered('low'), tool, answered('low'), user], claude, 'high'),
			// It lands on a user message merged with tool results: no update, the request carries the level asked now
			planAnthropicEffortUpdates([user, answered('low'), tool, user], claude, 'high'),
		], [
			{ requestEffort: 'low', updates: [{ beforeUserMessage: 1, effort: 'high' }], mark: 'anthropic/claude-sonnet-5-5#high' },
			{ requestEffort: 'high', updates: [], mark: 'anthropic/claude-sonnet-5-5#high' },
		]);
	});

	test('провод Anthropic: системное сообщение без текста встаёт перед n-м ходом пользователя, результаты инструментов не считаются', () => {
		const body = JSON.stringify({
			model: 'claude-sonnet-5-5',
			output_config: { effort: 'low' },
			messages: [
				{ role: 'user', content: [{ type: 'text', text: 'q1' }] },
				{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
				{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] },
				{ role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
				{ role: 'user', content: 'q2' },
			],
		});
		const sent = JSON.parse(withAnthropicEffortUpdates(body, [{ beforeUserMessage: 1, effort: 'high' }]));
		assert.deepStrictEqual(
			{ effort: sent.output_config.effort, messages: sent.messages.map((message: { role: string; output_config?: unknown }) => message.output_config ? { role: message.role, output_config: message.output_config } : message.role) },
			{ effort: 'low', messages: ['user', 'assistant', 'user', 'assistant', { role: 'system', output_config: { effort: 'high' } }, 'user'] },
		);
	});
});
