/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { autoFallbackCandidates, RoutingDecision, TaskAwareModelRouter, TaskContext } from '../../common/modelRouter.js';
import { RoutingEvaluationService } from '../../common/routingEvaluation.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../../common/vibeideSettingsService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider, ModelSelection } from '../../common/vibeideSettingsTypes.js';

/**
 * «Авто» отвечает моделью, которую взвешивание поставило первой
 * Дешёвой модели «на пробу» здесь нет: без проверки качества липкость закрепила бы её на весь разговор
 * Запасные модели идут по убыванию веса и пробуются только после ошибки
 */
suite('«Авто»: отвечает лучшая по весу модель, запасные — только после ошибки', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const mini = 'gpt-5-mini';
	const strong = 'gpt-5';

	/**
	 * A router over one OpenAI provider with the given models
	 * Each call is a fresh router: learned scores start empty, so only the rules rank
	 */
	function createRouter(modelNames: readonly string[]): TaskAwareModelRouter {
		const state = {
			settingsOfProvider: {
				openAI: {
					...defaultSettingsOfProvider.openAI,
					apiKey: 'k',
					_didFillInProviderSettings: true,
					models: modelNames.map(modelName => ({ modelName, type: 'default', isHidden: false })),
				},
			},
			overridesOfModel: {},
			globalSettings: defaultGlobalSettings,
		} as unknown as VibeideSettingsState;
		const settings = { state, onDidChangeState: Event.None } as unknown as IVibeideSettingsService;
		const disposables = store.add(new DisposableStore());
		return disposables.add(new TaskAwareModelRouter(settings, disposables.add(new InMemoryStorageService())));
	}

	/** The chosen model followed by the fallback chain, by name */
	function ranking(decision: RoutingDecision): string[] {
		return [decision.modelSelection.modelName, ...(decision.fallbackChain ?? []).map(model => model.modelName)];
	}

	// Both contexts keep the best score at or below the early-exit bar, so the full scored path is exercised
	const complexReasoning: TaskContext = { taskType: 'general', requiresComplexReasoning: true };
	const security: TaskContext = { taskType: 'general', isSecurityTask: true };

	test('сложная задача и задача безопасности: отвечает сильная модель, мини уходит в запасные', async () => {
		// Mini is listed first so that a choice by position would also show up as a failure
		assert.deepStrictEqual([
			ranking(await createRouter([mini, strong]).route(complexReasoning)),
			ranking(await createRouter([mini, strong]).route(security)),
		], [
			[strong, mini],
			[strong, mini],
		]);
	});

	/**
	 * Запасная цепочка — это продолжение того же взвешивания: без выбранной модели «Авто» взяло бы первую запасную,
	 * а остальные запасные сохранили бы порядок
	 * Свойство проверяется без знания весов, поэтому настройка весов тест не ломает
	 * Два набора: в первом лучший вес ниже порога раннего выхода, во втором выше — цепочка нужна на обоих путях
	 */
	test('запасная цепочка идёт по убыванию веса и не содержит выбранную модель', async () => {
		const modelSets = [
			['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'gpt-4o'],
			['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o'],
		];
		const chainProperties = async (models: readonly string[]) => {
			const first = ranking(await createRouter(models).route(complexReasoning));
			const withoutChosen = ranking(await createRouter(models.filter(name => name !== first[0])).route(complexReasoning));
			return {
				chainLength: first.length - 1,
				chosenInChain: first.slice(1).includes(first[0]),
				chainIsNextRanking: withoutChosen.slice(0, first.length - 1).join() === first.slice(1).join(),
			};
		};
		const expected = { chainLength: 3, chosenInChain: false, chainIsNextRanking: true };
		assert.deepStrictEqual(await Promise.all(modelSets.map(chainProperties)), [expected, expected]);
	});

	test('простой вопрос по-прежнему идёт быстрым путём на быструю модель', async () => {
		const decision = await createRouter([strong, mini]).route({ taskType: 'chat', isSimpleQuestion: true });
		assert.deepStrictEqual(
			{ model: decision.modelSelection.modelName, source: decision.source, qualityTier: decision.qualityTier },
			{ model: mini, source: 'fast-path', qualityTier: 'cheap_fast' },
		);
	});

	/**
	 * Ход получает ровно то ранжирование, которое построил выбор модели, а не пересчёт по урезанному контексту
	 * Выбранная модель стоит первой: ход без маршрутизации (липкий, продолженный) её ещё не пробовал
	 */
	test('кандидаты на замену — выбранная модель и её запасная цепочка; при отказе выбирать — никого', async () => {
		const decision = await createRouter([mini, strong]).route(complexReasoning);
		assert.deepStrictEqual({
			candidates: autoFallbackCandidates(decision).map(model => model.modelName),
			abstained: autoFallbackCandidates({ ...decision, shouldAbstain: true }),
		}, {
			candidates: ranking(decision),
			abstained: [],
		});
	});
});

/**
 * Обученная часть веса слышит только исходы, которым ход вынес вердикт
 * Решение без вердикта (ход прервали, запись из старых версий) модель не наказывает
 * Нейтральный априор весом в четыре исхода не даёт одной ошибке обнулить свежую модель
 */
suite('«Авто»: обученная часть веса считает только оценённые исходы', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const sonnet: ModelSelection = { providerName: 'anthropic', modelName: 'claude-sonnet-5' };
	const outcomesKey = 'vibeide.routing.outcomes';

	function createJournal(storedOutcomes?: unknown[]): RoutingEvaluationService {
		const storage = store.add(new InMemoryStorageService());
		if (storedOutcomes) {
			storage.store(outcomesKey, JSON.stringify(storedOutcomes), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return new RoutingEvaluationService(storage);
	}

	test('записи старых версий без вердикта и свежие решения без вердикта — нейтральные 0.5', () => {
		const legacy = createJournal(Array.from({ length: 5 }, (_, index) => ({ timestamp: index, modelSelection: sonnet, taskType: 'code', confidence: 0.9 })));
		const fresh = createJournal();
		fresh.recordOutcome({ id: 'a', timestamp: 1, modelSelection: sonnet, taskType: 'code', confidence: 0.9 });
		assert.deepStrictEqual([legacy.getModelSuccessRate(sonnet), fresh.getModelSuccessRate(sonnet)], [0.5, 0.5]);
	});

	test('вердикт находит исход по ключу, первый вердикт окончательный, одна ошибка не обнуляет модель', () => {
		const journal = createJournal();
		const rates: number[] = [];
		journal.recordOutcome({ id: 'a', timestamp: 1, modelSelection: sonnet, taskType: 'code', confidence: 0.9 });
		journal.recordOutcome({ id: 'b', timestamp: 1, modelSelection: sonnet, taskType: 'code', confidence: 0.9 });
		journal.updateOutcome('a', { success: false, escalated: true });
		rates.push(journal.getModelSuccessRate(sonnet));
		journal.updateOutcome('a', { success: true });
		journal.updateOutcome('missing', { success: true });
		rates.push(journal.getModelSuccessRate(sonnet));
		journal.updateOutcome('b', { success: true });
		rates.push(journal.getModelSuccessRate(sonnet));
		assert.deepStrictEqual(rates, [0.4, 0.4, 0.5]);
	});

	test('решение роутера несёт ключ исхода, и решение из кэша получает свой', async () => {
		const disposables = store.add(new DisposableStore());
		const state = {
			settingsOfProvider: {
				openAI: {
					...defaultSettingsOfProvider.openAI,
					apiKey: 'k',
					_didFillInProviderSettings: true,
					models: ['gpt-5', 'gpt-5-mini'].map(modelName => ({ modelName, type: 'default', isHidden: false })),
				},
			},
			overridesOfModel: {},
			globalSettings: defaultGlobalSettings,
		} as unknown as VibeideSettingsState;
		const settings = { state, onDidChangeState: Event.None } as unknown as IVibeideSettingsService;
		const router = disposables.add(new TaskAwareModelRouter(settings, disposables.add(new InMemoryStorageService())));
		const context: TaskContext = { taskType: 'general', requiresComplexReasoning: true };
		const first = await router.route(context);
		const cached = await router.route(context);
		assert.deepStrictEqual({
			firstHasId: typeof first.outcomeId === 'string',
			cachedHasId: typeof cached.outcomeId === 'string',
			distinct: first.outcomeId !== cached.outcomeId,
			sameModel: cached.modelSelection.modelName === first.modelSelection.modelName,
		}, { firstHasId: true, cachedHasId: true, distinct: true, sameModel: true });
	});
});
