/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinWireSdkNpm, getModelCapabilities, getProviderCapabilities, resolveProvider } from '../../common/modelCapabilities.js';
import { providerNames } from '../../common/vibeideSettingsTypes.js';

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
			resolved('anthropic', 'claude-fable-5-1'),
			resolved('anthropic', 'claude-mythos-5-1'),
			resolved('anthropic', 'claude-fable-5'),
			resolved('anthropic', 'claude-mythos-5'),
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
			'claude-fable-5-1 ← claude-fable-5-1',
			'claude-mythos-5-1 ← claude-fable-5-1',
			'claude-fable-5 ← claude-fable-5',
			'claude-mythos-5 ← claude-fable-5',
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

	test('Fable и Mythos, прежние Claude: цены со страницы вендора, мышление Fable не выключается', () => {
		const card = (modelName: string) => {
			const caps = getModelCapabilities('anthropic', modelName, undefined);
			const reasoning = caps.reasoningCapabilities || undefined;
			const slider = reasoning?.reasoningSlider?.type === 'effort_slider' ? reasoning.reasoningSlider : undefined;
			return { model: modelName, cost: caps.cost, default: slider?.default, canTurnOff: reasoning?.canTurnOffReasoning };
		};
		assert.deepStrictEqual(['claude-fable-5-1', 'claude-mythos-5', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(card), [
			{ model: 'claude-fable-5-1', cost: { input: 10, cache_read: 0.25, cache_write: 12.5, output: 50 }, default: 'high', canTurnOff: false },
			{ model: 'claude-mythos-5', cost: { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }, default: 'high', canTurnOff: false },
			{ model: 'claude-opus-4-5', cost: { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }, default: undefined, canTurnOff: true },
			{ model: 'claude-opus-4-1', cost: { input: 15, cache_read: 1.5, cache_write: 18.75, output: 75 }, default: undefined, canTurnOff: true },
			{ model: 'claude-sonnet-4-5', cost: { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 }, default: undefined, canTurnOff: true },
			{ model: 'claude-haiku-4-5', cost: { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 }, default: undefined, canTurnOff: undefined },
		]);
	});

	test('DeepSeek: нативные вызовы у каждой модели, картинки у Flash, цена по часам, незнакомый id', () => {
		const card = (modelName: string) => {
			const caps = getModelCapabilities('deepseek', modelName, undefined);
			const cost = caps.cost;
			return {
				model: `${caps.modelName} ← ${caps.recognizedModelName ?? '—'}`,
				tools: caps.specialToolFormat,
				vision: caps.supportsVision,
				cost: { input: cost.input, output: cost.output, cache_read: cost.cache_read },
				offPeakFactor: cost.time_of_day?.offPeakFactor,
				replacedBy: caps.deprecation?.replacedBy,
			};
		};
		assert.deepStrictEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v5-preview'].map(card), [
			{ model: 'deepseek-flash ← deepseek-flash', tools: 'openai-style', vision: true, cost: { input: 0.30, output: 1.20, cache_read: 0.006 }, offPeakFactor: 0.5, replacedBy: undefined },
			{ model: 'deepseek-v4-pro ← deepseek-v4-pro', tools: 'openai-style', vision: false, cost: { input: 1.32, output: 3.96, cache_read: 0.044 }, offPeakFactor: 0.5, replacedBy: undefined },
			{ model: 'deepseek-v4-flash ← deepseek-v4-flash', tools: 'openai-style', vision: true, cost: { input: 0.30, output: 1.20, cache_read: 0.006 }, offPeakFactor: 0.5, replacedBy: 'deepseek-flash' },
			{ model: 'deepseek-v5-preview ← deepseek-v4-pro', tools: 'openai-style', vision: false, cost: { input: 1.32, output: 3.96, cache_read: 0.044 }, offPeakFactor: 0.5, replacedBy: undefined },
		]);
	});

	/**
	 * Модель облачного провайдера без `specialToolFormat` молча уходит в XML-режим: запрос идёт без `tools`,
	 * и модель, обученная на собственной разметке вызовов, пишет её в текст. Так весь встроенный DeepSeek
	 * работал в XML-режиме, пока каталог квирков утверждал обратное
	 * Локальные и произвольные OpenAI-совместимые провайдеры не проверяются: там умения зависят от того, что поднято
	 *
	 * Исключения ниже — каждое с причиной по первоисточнику вендора (сверено 30.09.2026)
	 * Новая модель без формата роняет тест, и модель, получившая формат, но оставленная в исключениях, тоже
	 */
	test('каждая модель облачного встроенного провайдера объявляет формат вызовов', () => {
		const servedByUser = new Set(['ollama', 'vLLM', 'lmStudio', 'openAICompatible']);
		const offOpenRouter = 'снята с OpenRouter: ни одного эндпоинта (api/v1/models/<id>/endpoints)';
		const withoutToolFormat: Record<string, string> = {
			'openRouter/microsoft/phi-4-reasoning-plus:free': offOpenRouter,
			'openRouter/mistralai/mistral-small-3.1-24b-instruct:free': offOpenRouter,
			'openRouter/google/gemini-2.0-flash-lite-preview-02-05:free': offOpenRouter,
			'openRouter/google/gemini-2.0-pro-exp-02-05:free': offOpenRouter,
			'openRouter/google/gemini-2.0-flash-exp:free': offOpenRouter,
			'openRouter/deepseek/deepseek-r1-zero:free': offOpenRouter,
			'openRouter/anthropic/claude-opus-4': offOpenRouter,
			'openRouter/anthropic/claude-3.7-sonnet:thinking': offOpenRouter,
			'openRouter/anthropic/claude-3.7-sonnet': offOpenRouter,
			'openRouter/anthropic/claude-3.5-sonnet': offOpenRouter,
			'openRouter/mistralai/codestral-2501': offOpenRouter,
			'openRouter/mistralai/devstral-small:free': offOpenRouter,
			'openRouter/qwen/qwen-2.5-coder-32b-instruct': 'в supported_parameters нет tools, единственный провайдер без инструментов',
			'openRouter/qwen/qwq-32b': offOpenRouter,
			'groq/qwen-2.5-coder-32b': 'выключена Groq 14.04.2025 (console.groq.com/docs/deprecations)',
			'groq/qwen-qwq-32b': 'выключена Groq 14.07.2025 (console.groq.com/docs/deprecations)',
			'openAI/o1-mini': 'Function calling: Not supported; выключена 27.10.2025, замена o4-mini',
		};
		const found = providerNames
			.filter(provider => !servedByUser.has(provider))
			.flatMap(provider => Object.keys(resolveProvider(provider)?.info.modelOptions ?? {})
				.filter(modelName => !getModelCapabilities(provider, modelName, undefined).specialToolFormat)
				.map(modelName => `${provider}/${modelName}`));
		assert.deepStrictEqual(found, Object.keys(withoutToolFormat));
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
