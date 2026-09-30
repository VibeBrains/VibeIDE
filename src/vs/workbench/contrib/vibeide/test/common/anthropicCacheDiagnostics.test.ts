/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isCostlyCacheMiss, readAnthropicMessageStart } from '../../common/anthropicCacheDiagnostics.js';

/**
 * Диагностика кэша Anthropic: id ответа и причина промаха читаются из `message_start`
 * (platform.claude.com/docs/en/build-with-claude/cache-diagnostics); в ленту — только изменение, стоившее токенов
 */
suite('anthropicCacheDiagnostics — причина промаха кэша', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const start = (diagnostics: unknown) => `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_2', model: 'claude-opus-5-5', diagnostics } })}\n\n`;

	test('id и причина из начала потока; null — сообщать нечего; обрезанная строка — ждать следующего куска', () => {
		assert.deepStrictEqual([
			readAnthropicMessageStart(start({ cache_miss_reason: { type: 'tools_changed', cache_missed_input_tokens: 12_000 } })),
			readAnthropicMessageStart(start({ cache_miss_reason: { type: 'previous_message_not_found' } })),
			readAnthropicMessageStart(start(null)),
			readAnthropicMessageStart(start({ cache_miss_reason: null })),
			readAnthropicMessageStart('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_'),
			readAnthropicMessageStart('event: ping\ndata: {"type":"ping"}\n\n'),
		], [
			{ id: 'msg_2', cacheMiss: { kind: 'tools_changed', missedInputTokens: 12_000 } },
			{ id: 'msg_2', cacheMiss: { kind: 'previous_message_not_found' } },
			{ id: 'msg_2' },
			{ id: 'msg_2' },
			undefined,
			undefined,
		]);
	});

	test('в ленту — только изменение запроса, стоившее кэшированных токенов', () => {
		assert.deepStrictEqual([
			isCostlyCacheMiss({ kind: 'system_changed', missedInputTokens: 800 }),
			isCostlyCacheMiss({ kind: 'messages_changed', missedInputTokens: 0 }),
			isCostlyCacheMiss({ kind: 'previous_message_not_found' }),
			isCostlyCacheMiss({ kind: 'unavailable' }),
			isCostlyCacheMiss(undefined),
		], [true, false, false, false, false]);
	});
});
