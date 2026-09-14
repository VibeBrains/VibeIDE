/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { isModelSubstituted, modelFromAnthropicEvent, modelFromGeminiEvent, modelFromOpenAiChunk, readAnsweredModel } from '../../common/modelEcho.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

/**
 * Вектор перенесён из VibeIDEA (`ModelEchoTest.kt`) дословно: правило общее для обоих продуктов, и
 * расходиться оно может только вместе — строкой в векторе каждого.
 */
suite('Кто ответил на самом деле', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('каждый провод называет модель по-своему, а молчащее событие молчит', () => {
		assert.deepStrictEqual([
			modelFromOpenAiChunk(JSON.parse('{"model":"gpt-4o-2024-08-06","choices":[]}')),
			modelFromAnthropicEvent(JSON.parse('{"type":"message_start","message":{"model":"claude-opus-5"}}')),
			modelFromGeminiEvent(JSON.parse('{"modelVersion":"gemini-3.8-flash","candidates":[]}')),
			modelFromOpenAiChunk(JSON.parse('{"choices":[]}')),
			modelFromAnthropicEvent(JSON.parse('{"type":"content_block_delta"}')),
			modelFromGeminiEvent(JSON.parse('{"candidates":[]}')),
			modelFromOpenAiChunk(JSON.parse('{"model":"  "}')),
		], ['gpt-4o-2024-08-06', 'claude-opus-5', 'gemini-3.8-flash', undefined, undefined, undefined, undefined]);
	});

	test('та же модель, написанная иначе, — не подмена', () => {
		const same: ReadonlyArray<readonly [string, string]> = [
			['gpt-4o', 'gpt-4o-2024-08-06'],
			['openai/gpt-4o', 'gpt-4o'],
			['gpt-4o', 'openai/gpt-4o'],
			['claude-opus-5', 'Claude-Opus-5'],
			['qwen3-max', 'qwen3-max@2026-01-01'],
			['kimi-k2', 'kimi-k2-0905-preview'],
			['gemini-3.8-flash', 'gemini-3.8-flash-002'],
		];
		assert.deepStrictEqual(same.map(([asked, got]) => isModelSubstituted(asked, got)), same.map(() => false));
	});

	test('другая модель — подмена, и хвост-слово её не прячет', () => {
		const other: ReadonlyArray<readonly [string, string]> = [
			['claude-opus-5', 'claude-haiku-4-5'],
			['gpt-4o', 'gpt-4o-mini'],
			['gpt-4o', 'gpt-4o-mini-2024-07-18'],
			['openai/gpt-4o', 'anthropic/claude-opus-5'],
		];
		assert.deepStrictEqual(other.map(([asked, got]) => isModelSubstituted(asked, got)), other.map(() => true));
	});

	test('молчание — не обвинение', () => {
		assert.deepStrictEqual(
			[isModelSubstituted('gpt-4o', undefined), isModelSubstituted('gpt-4o', '   '), isModelSubstituted('', 'gpt-4o')],
			[false, false, false],
		);
	});

	test('имя читается с головы ответа: поток, целый ответ, обрезанная голова', () => {
		assert.deepStrictEqual([
			readAnsweredModel('data: {"model":"fugu-max","choices":[]}\n\ndata: [DONE]\n'),
			readAnsweredModel('event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5"}}\n'),
			readAnsweredModel('data: {"modelVersion":"gemini-3.8-flash"}\n'),
			readAnsweredModel('{"id":"x","object":"chat.completion","created":1,"model":"fugu-ultra","choices":[{"index":0'),
			readAnsweredModel('data: {"choices":[]}\n'),
		], ['fugu-max', 'claude-opus-5', 'gemini-3.8-flash', 'fugu-ultra', undefined]);
	});
});
