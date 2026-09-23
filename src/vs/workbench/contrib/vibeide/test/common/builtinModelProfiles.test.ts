/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinWireSdkNpm, getModelCapabilities, getProviderCapabilities } from '../../common/modelCapabilities.js';

/**
 * Встроенные провайдеры: какая модель уходит на провод, чей профиль она получает и каким проводом идёт.
 *
 * Запасные записи Anthropic, OpenAI и xAI подменяли имя модели в запросе (выбран `claude-opus-5-5` —
 * уходил `claude-opus-5`), а в их цепочках побеждало последнее совпадение, и `claude-sonnet-4-5` получал
 * профиль Sonnet 4.0.
 */
suite('builtin model profiles — имя на проводе, профиль, провод', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const resolved = (provider: 'anthropic' | 'openAI' | 'xAI', modelName: string) => {
		const caps = getModelCapabilities(provider, modelName, undefined);
		return `${caps.modelName} ← ${caps.recognizedModelName ?? '—'}`;
	};

	test('имя модели уходит тем, что выбрано; профиль — по первому совпадению от частного к общему', () => {
		assert.deepStrictEqual([
			resolved('anthropic', 'claude-opus-5-5'),
			resolved('anthropic', 'claude-opus-5-5-20260915'),
			resolved('anthropic', 'claude-opus-5'),
			resolved('anthropic', 'claude-opus-4-8'),
			resolved('anthropic', 'claude-sonnet-4-5'),
			resolved('anthropic', 'claude-opus-4-5'),
			resolved('anthropic', 'claude-opus-4-1'),
			resolved('anthropic', 'claude-opus-4-6'),
			resolved('anthropic', 'claude-haiku-4-5'),
			resolved('openAI', 'gpt-5.5'),
			resolved('openAI', 'gpt-5-mini-2025-08-07'),
			resolved('openAI', 'gpt-6-luna'),
			resolved('openAI', 'gpt-6-luna-2026-09-22'),
			resolved('openAI', 'gpt-6-mini'),
			resolved('openAI', 'gpt-4o-2024-08-06'),
			resolved('openAI', 'o3-mini-high'),
			resolved('xAI', 'grok-4-fast'),
			resolved('xAI', 'grok-3-mini-fast-beta'),
		], [
			'claude-opus-5-5 ← claude-opus-5-5',
			'claude-opus-5-5-20260915 ← claude-opus-5-5',
			'claude-opus-5 ← claude-opus-5',
			'claude-opus-4-8 ← claude-opus-5',
			'claude-sonnet-4-5 ← claude-sonnet-4-5-20250929',
			'claude-opus-4-5 ← claude-opus-4-5-20251101',
			'claude-opus-4-1 ← claude-opus-4-1-20250805',
			'claude-opus-4-6 ← claude-opus-4-20250514',
			'claude-haiku-4-5 ← claude-haiku-4-5-20251001',
			'gpt-5.5 ← gpt-5',
			'gpt-5-mini-2025-08-07 ← gpt-5-mini',
			'gpt-6-luna ← gpt-6-luna',
			'gpt-6-luna-2026-09-22 ← gpt-6-luna',
			'gpt-6-mini ← gpt-6-sol',
			'gpt-4o-2024-08-06 ← gpt-4o',
			'o3-mini-high ← o3-mini',
			'grok-4-fast ← grok-4',
			'grok-3-mini-fast-beta ← grok-3-mini-fast',
		]);
	});

	test('Opus 5.5 и GPT-6: цены, уровни, умолчание, выключатель, вывод', () => {
		const card = (provider: 'anthropic' | 'openAI', modelName: string) => {
			const caps = getModelCapabilities(provider, modelName, undefined);
			const reasoning = caps.reasoningCapabilities || undefined;
			const slider = reasoning?.reasoningSlider?.type === 'effort_slider' ? reasoning.reasoningSlider : undefined;
			return {
				cost: caps.cost,
				output: caps.reservedOutputTokenSpace,
				levels: slider?.values.join('/'),
				default: slider?.default,
				canTurnOff: reasoning?.canTurnOffReasoning,
				off: reasoning?.reasoningOffEffort,
			};
		};
		const longContext = { over_input_tokens: 272_000, input: 2, cache: 2, output: 1.5 };
		assert.deepStrictEqual([card('anthropic', 'claude-opus-5-5'), card('anthropic', 'claude-opus-5'), card('openAI', 'gpt-6-sol'), card('openAI', 'gpt-6-astra')], [
			{ cost: { input: 4, cache_read: 0.2, cache_write: 5, output: 20 }, output: 64_000, levels: 'low/medium/high/xhigh/max', default: 'medium', canTurnOff: false, off: undefined },
			{ cost: { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }, output: 64_000, levels: 'low/medium/high/xhigh/max', default: 'high', canTurnOff: false, off: undefined },
			{ cost: { input: 2, cache_read: 0.2, cache_write: 2.5, output: 10, long_context: longContext }, output: 128_000, levels: 'low/medium/high/xhigh/max', default: 'medium', canTurnOff: true, off: 'none' },
			{ cost: { input: 10, cache_read: 1, cache_write: 12.5, output: 50, long_context: longContext }, output: 128_000, levels: 'low/medium/high/xhigh/max', default: 'medium', canTurnOff: false, off: undefined },
		]);
	});

	test('провод встроенного: свой у Anthropic, Gemini и локальных, у OpenAI — Responses для GPT-6', () => {
		const catalogProtocol = (modelName: string) => getProviderCapabilities('openAI').wireProtocolOfModel?.(getModelCapabilities('openAI', modelName, undefined).recognizedModelName ?? modelName);
		assert.deepStrictEqual([
			builtinWireSdkNpm('anthropic', 'anthropic', undefined),
			builtinWireSdkNpm('gemini', undefined, undefined),
			builtinWireSdkNpm('ollama', undefined, undefined),
			builtinWireSdkNpm('openAI', 'openai', catalogProtocol('gpt-5.5')),
			builtinWireSdkNpm('openAI', undefined, catalogProtocol('gpt-6-luna')),
			builtinWireSdkNpm('openAI', 'openai-responses', undefined),
			builtinWireSdkNpm('deepseek', 'openai', undefined),
			builtinWireSdkNpm('openCodeZen', 'openai', undefined),
		], [
			'@ai-sdk/anthropic',
			'@ai-sdk/google',
			'@ai-sdk/openai-compatible',
			'@ai-sdk/openai',
			'@ai-sdk/openai#responses',
			'@ai-sdk/openai#responses',
			undefined,
			undefined,
		]);
	});
});
