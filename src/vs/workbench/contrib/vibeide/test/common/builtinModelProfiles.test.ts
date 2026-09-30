/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinWireSdkNpm, getModelCapabilities, getProviderCapabilities, resolveProvider } from '../../common/modelCapabilities.js';
import { deprecationStatus } from '../../common/modelDeprecation.js';
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
			'claude-opus-4-1 ← claude-opus-4-6',
			'claude-opus-4-6 ← claude-opus-4-6',
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

	/**
	 * Claude 4.6 — своя запись: без неё Opus 4.6 брал профиль выключенной Opus 4.0 и считался втрое дороже ($15/$75)
	 * Выключенные 4.0 и 4.1, которые ещё может отдавать шлюз, получают профиль 4.6 — замену, названную вендором
	 * Sonnet 4.5 вендор выключает 30.11.2026 (platform.claude.com, model-deprecations, сверено 30.09.2026)
	 */
	test('Fable и Mythos, прежние Claude: цены со страницы вендора, мышление Fable не выключается', () => {
		const card = (modelName: string) => {
			const caps = getModelCapabilities('anthropic', modelName, undefined);
			const reasoning = caps.reasoningCapabilities || undefined;
			const slider = reasoning?.reasoningSlider?.type === 'effort_slider' ? reasoning.reasoningSlider : undefined;
			return { model: modelName, cost: caps.cost, levels: slider?.values.join('/'), default: slider?.default, canTurnOff: reasoning?.canTurnOffReasoning, retires: caps.deprecation?.date };
		};
		assert.deepStrictEqual(['claude-fable-5-1', 'claude-mythos-5', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5'].map(card), [
			{ model: 'claude-fable-5-1', cost: { input: 10, cache_read: 0.25, cache_write: 12.5, output: 50 }, levels: 'low/medium/high/xhigh/max', default: 'high', canTurnOff: false, retires: undefined },
			{ model: 'claude-mythos-5', cost: { input: 10, cache_read: 1, cache_write: 12.5, output: 50 }, levels: 'low/medium/high/xhigh/max', default: 'high', canTurnOff: false, retires: undefined },
			{ model: 'claude-opus-4-6', cost: { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }, levels: 'low/medium/high/max', default: 'high', canTurnOff: true, retires: undefined },
			{ model: 'claude-sonnet-4-6', cost: { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 }, levels: 'low/medium/high/max', default: 'high', canTurnOff: true, retires: undefined },
			{ model: 'claude-opus-4-5', cost: { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }, levels: undefined, default: undefined, canTurnOff: true, retires: undefined },
			{ model: 'claude-opus-4-1', cost: { input: 5, cache_read: 0.5, cache_write: 6.25, output: 25 }, levels: 'low/medium/high/max', default: 'high', canTurnOff: true, retires: undefined },
			{ model: 'claude-sonnet-4-5', cost: { input: 3, cache_read: 0.3, cache_write: 3.75, output: 15 }, levels: undefined, default: undefined, canTurnOff: true, retires: '2026-11-30' },
			{ model: 'claude-haiku-4-5', cost: { input: 1, cache_read: 0.1, cache_write: 1.25, output: 5 }, levels: undefined, default: undefined, canTurnOff: undefined, retires: undefined },
		]);
	});

	/**
	 * Claude через шлюз распознаётся той же таблицей, что у прямого провайдера: вторая копия правил отстала,
	 * и любая Claude 5 через OpenRouter получала профиль Sonnet 3.7
	 */
	test('Claude через шлюз: та же таблица, что у прямого провайдера; выключенные 3.x — на живой профиль своей линии', () => {
		const via = (modelName: string) => `${modelName} ← ${getModelCapabilities('openRouter', modelName, undefined).recognizedModelName}`;
		assert.deepStrictEqual([
			'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-fable-5.1', 'anthropic/claude-opus-4.6',
			'anthropic/claude-3.7-sonnet', 'anthropic/claude-3-opus', 'anthropic/claude-3.5-haiku', 'anthropic/claude-next',
		].map(via), [
			'anthropic/claude-opus-5 ← claude-opus-5',
			'anthropic/claude-sonnet-5.5 ← claude-sonnet-5-5',
			'anthropic/claude-fable-5.1 ← claude-fable-5-1',
			'anthropic/claude-opus-4.6 ← claude-opus-4-6',
			'anthropic/claude-3.7-sonnet ← claude-sonnet-4-6',
			'anthropic/claude-3-opus ← claude-opus-4-6',
			'anthropic/claude-3.5-haiku ← claude-haiku-4-5-20251001',
			'anthropic/claude-next ← claude-sonnet-5-5',
		]);
	});

	/**
	 * Новое поколение модели получает свою ветку распознавания: провалившись в ветку прошлого, GLM-5.3 получал «выключено»,
	 * которое вендор отвергает с 400, K3 — пятую часть своей цены, GPT-6.1 Sol — уровень `none`, которого у него нет,
	 * а Sonnet 5.5 — профиль Sonnet 5 без своего «выключено»
	 */
	test('новые поколения по имени: Sonnet 5.5, GPT-6.1 Sol, Kimi K3 и Kimi Code, GLM-5.3', () => {
		const card = (provider: 'anthropic' | 'openAI' | 'openRouter', modelName: string) => {
			const caps = getModelCapabilities(provider, modelName, undefined);
			const reasoning = caps.reasoningCapabilities || undefined;
			const slider = reasoning?.reasoningSlider?.type === 'effort_slider' ? reasoning.reasoningSlider : undefined;
			return {
				model: `${provider}/${modelName} ← ${caps.recognizedModelName ?? '—'}`,
				canTurnOff: reasoning?.canTurnOffReasoning,
				off: reasoning?.reasoningOffPayload ?? reasoning?.reasoningOffEffort,
				levels: slider?.values.join('/'),
				default: slider?.default,
				cost: `${caps.cost.input}/${caps.cost.output}/${caps.cost.cache_read ?? '—'}`,
			};
		};
		assert.deepStrictEqual([
			card('anthropic', 'claude-sonnet-5-5'),
			card('anthropic', 'claude-sonnet-5-5-20260928'),
			card('openAI', 'gpt-6.1-sol'),
			card('openRouter', 'moonshotai/kimi-k3'),
			card('openRouter', 'k3-256k'),
			card('openRouter', 'kimi-for-coding'),
			card('openRouter', 'z-ai/glm-5.3'),
			card('openRouter', 'z-ai/glm-5.3-flash'),
		], [
			{ model: 'anthropic/claude-sonnet-5-5 ← claude-sonnet-5-5', canTurnOff: true, off: { thinking: { type: 'between_tools' } }, levels: 'low/medium/high/xhigh/max', default: 'high', cost: '2/10/0.2' },
			{ model: 'anthropic/claude-sonnet-5-5-20260928 ← claude-sonnet-5-5', canTurnOff: true, off: { thinking: { type: 'between_tools' } }, levels: 'low/medium/high/xhigh/max', default: 'high', cost: '2/10/0.2' },
			{ model: 'openAI/gpt-6.1-sol ← gpt-6.1-sol', canTurnOff: false, off: undefined, levels: 'low/medium/high/xhigh/max', default: 'medium', cost: '2/10/0.1' },
			{ model: 'openRouter/moonshotai/kimi-k3 ← kimiK3', canTurnOff: false, off: undefined, levels: 'low/high/max', default: 'high', cost: '3/15/0.3' },
			{ model: 'openRouter/k3-256k ← kimiK3', canTurnOff: false, off: undefined, levels: 'low/high/max', default: 'high', cost: '3/15/0.3' },
			{ model: 'openRouter/kimi-for-coding ← kimiForCoding', canTurnOff: true, off: { reasoning_effort: 'none' }, levels: 'low/high/max', default: 'max', cost: '0.6/2.5/—' },
			{ model: 'openRouter/z-ai/glm-5.3 ← glm5.3', canTurnOff: false, off: undefined, levels: 'low/high/max', default: 'high', cost: '1.4/4.4/—' },
			{ model: 'openRouter/z-ai/glm-5.3-flash ← glm5', canTurnOff: true, off: undefined, levels: undefined, default: undefined, cost: '1/3.2/—' },
		]);
	});

	/**
	 * Рассуждение V4 приходит своим полем `reasoning_content`, поэтому разбора `<think>` из текста у встроенного DeepSeek нет:
	 * Унаследованный от R1, он вырезал бы тег из ответа, который его цитирует, вместе со всем, что за ним
	 */
	test('DeepSeek: нативные вызовы у каждой модели, картинки у Flash, цена по часам, без разбора <think>, незнакомый id', () => {
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
				thinkTags: caps.reasoningCapabilities ? caps.reasoningCapabilities.openSourceThinkTags : 'нет рассуждения',
			};
		};
		assert.deepStrictEqual(['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v5-preview'].map(card), [
			{ model: 'deepseek-flash ← deepseek-flash', tools: 'openai-style', vision: true, cost: { input: 0.30, output: 1.20, cache_read: 0.006 }, offPeakFactor: 0.5, replacedBy: undefined, thinkTags: undefined },
			{ model: 'deepseek-v4-pro ← deepseek-v4-pro', tools: 'openai-style', vision: false, cost: { input: 1.32, output: 3.96, cache_read: 0.044 }, offPeakFactor: 0.5, replacedBy: undefined, thinkTags: undefined },
			{ model: 'deepseek-v4-flash ← deepseek-v4-flash', tools: 'openai-style', vision: true, cost: { input: 0.30, output: 1.20, cache_read: 0.006 }, offPeakFactor: 0.5, replacedBy: 'deepseek-flash', thinkTags: undefined },
			{ model: 'deepseek-v5-preview ← deepseek-v4-pro', tools: 'openai-style', vision: false, cost: { input: 1.32, output: 3.96, cache_read: 0.044 }, offPeakFactor: 0.5, replacedBy: undefined, thinkTags: undefined },
		]);
	});

	/**
	 * Модель облачного провайдера без `specialToolFormat` молча уходит в XML-режим: запрос идёт без `tools`,
	 * и модель, обученная на собственной разметке вызовов, пишет её в текст. Так весь встроенный DeepSeek
	 * работал в XML-режиме, пока каталог квирков утверждал обратное
	 * Локальные и произвольные OpenAI-совместимые провайдеры не проверяются: там умения зависят от того, что поднято
	 *
	 * Исключение ниже — с причиной по первоисточнику вендора (сверено 30.09.2026)
	 * Новая модель без формата роняет тест, и модель, получившая формат, но оставленная в исключениях, тоже
	 */
	test('каждая модель облачного встроенного провайдера объявляет формат вызовов', () => {
		const servedByUser = new Set(['ollama', 'vLLM', 'lmStudio', 'openAICompatible']);
		const withoutToolFormat: Record<string, string> = {
			'openRouter/qwen/qwen-2.5-coder-32b-instruct': 'в supported_parameters нет tools, единственный провайдер без инструментов',
		};
		const found = providerNames
			.filter(provider => !servedByUser.has(provider))
			.flatMap(provider => Object.keys(resolveProvider(provider)?.info.modelOptions ?? {})
				.filter(modelName => !getModelCapabilities(provider, modelName, undefined).specialToolFormat)
				.map(modelName => `${provider}/${modelName}`));
		assert.deepStrictEqual(found, Object.keys(withoutToolFormat));
	});

	/**
	 * Выключенная вендором модель во встроенном списке отвечает 404, и пользователь узнаёт об этом посреди задачи
	 * Пометка `deprecation` с датой — отсрочка на переход, а не место хранения: через 90 дней после выключения
	 * запись удаляется, и тест падает, пока её держат
	 * Тест читает настоящие часы нарочно: список гниёт от времени, а не от правок
	 */
	test('выключенная больше 90 дней назад модель не держится во встроенном списке', () => {
		const retiredForDays = 90;
		const now = Date.now();
		const stale = providerNames.flatMap(provider => Object.keys(resolveProvider(provider)?.info.modelOptions ?? {})
			.map(modelName => ({ model: `${provider}/${modelName}`, status: deprecationStatus(getModelCapabilities(provider, modelName, undefined).deprecation, now) }))
			.filter(({ status }) => status?.daysLeft !== undefined && status.daysLeft < -retiredForDays)
			.map(({ model }) => model));
		assert.deepStrictEqual(stale, []);
	});

	test('провод встроенного: свой у Anthropic, Gemini и локальных, у OpenAI — Responses для GPT-6 и моделей только-Responses', () => {
		const catalogProtocol = (modelName: string) => getProviderCapabilities('openAI').wireProtocolOfModel?.(getModelCapabilities('openAI', modelName, undefined).recognizedModelName ?? modelName);
		assert.deepStrictEqual([
			builtinWireSdkNpm('anthropic', 'anthropic', undefined),
			builtinWireSdkNpm('gemini', undefined, undefined),
			builtinWireSdkNpm('ollama', undefined, undefined),
			builtinWireSdkNpm('openAI', 'openai', catalogProtocol('gpt-5.5')),
			builtinWireSdkNpm('openAI', undefined, catalogProtocol('gpt-6-luna')),
			builtinWireSdkNpm('openAI', undefined, catalogProtocol('o1-pro')),
			builtinWireSdkNpm('openAI', undefined, catalogProtocol('o3-pro-2025-06-10')),
			builtinWireSdkNpm('openAI', undefined, catalogProtocol('gpt-5-pro')),
			builtinWireSdkNpm('openAI', 'openai', catalogProtocol('o3')),
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
			'@ai-sdk/openai#responses',
			'@ai-sdk/openai#responses',
			'@ai-sdk/openai',
			'@ai-sdk/openai#responses',
			undefined,
			undefined,
		]);
	});
});
