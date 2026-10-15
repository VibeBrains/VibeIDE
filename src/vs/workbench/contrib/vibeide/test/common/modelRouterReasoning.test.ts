/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { getModelCapabilities } from '../../common/modelCapabilities.js';
import { reasoningScoreOf, RoutingDecision, TaskAwareModelRouter, TaskContext, taskDemandsReasoning } from '../../common/modelRouter.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../../common/vibeideSettingsService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { vibeLog } from '../../common/vibeLog.js';

/**
 * Слабость модели для задачи — оценка, а не запрет: модель без рассуждения остаётся кандидатом «Авто»
 * Она теряет очки только там, где задача опирается на рассуждение (код, несколько шагов, отладка, ревью, безопасность)
 * Там же думающая модель получает бонус; на лёгкой задаче (обычный чат, переписывание текста) бонуса нет ни у кого
 * Оценка читает признаки задачи, которые роутер уже знает, и профиль модели, но не её имя
 */
suite('«Авто»: модель без рассуждения слаба для задач, которые на рассуждение опираются', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The router logs a question about the codebase through `vibeLog`
	// The runner fails any test that writes to the console
	setup(() => vibeLog.configure({ enabled: false }));
	teardown(() => vibeLog.configure({ enabled: true }));

	const textModel = 'MiniMax-Text-01';
	const flashPreview = 'MiniMax-M3.1-Flash-Preview';
	const m3 = 'MiniMax-M3';
	const m2 = 'MiniMax-M2.7';

	test('какие задачи опираются на рассуждение', () => {
		const contexts: Record<string, TaskContext> = {
			'обычный чат': { taskType: 'chat', preferLowLatency: true },
			'простой вопрос': { taskType: 'chat', isSimpleQuestion: true },
			'перепись длинного текста': { taskType: 'chat', isLongMessage: true, isDocumentationTask: true },
			'код': { taskType: 'code', hasCode: true },
			'сложный разбор': { taskType: 'general', requiresComplexReasoning: true },
			'несколько шагов': { taskType: 'general', isMultiStepTask: true },
			'отладка': { taskType: 'general', isDebuggingTask: true },
			'ревью': { taskType: 'general', isCodeReviewTask: true },
			'производительность': { taskType: 'general', isPerformanceTask: true },
			'безопасность': { taskType: 'general', isSecurityTask: true },
		};
		assert.deepStrictEqual(Object.fromEntries(Object.entries(contexts).map(([name, context]) => [name, taskDemandsReasoning(context)])), {
			'обычный чат': false,
			'простой вопрос': false,
			'перепись длинного текста': false,
			'код': true,
			'сложный разбор': true,
			'несколько шагов': true,
			'отладка': true,
			'ревью': true,
			'производительность': true,
			'безопасность': true,
		});
	});

	/** Бонус и штраф есть только на задаче, что опирается на рассуждение; на лёгкой оценка рассуждения нулевая у всех */
	test('оценка рассуждения: бонус тем, кто думает, штраф тем, кто нет, и только на трудной задаче', () => {
		const light: TaskContext = { taskType: 'chat', isSimpleQuestion: true };
		const demanding: TaskContext = { taskType: 'code', hasCode: true, requiresComplexReasoning: true };
		const caps = (modelName: string) => getModelCapabilities('minimax', modelName, undefined);
		assert.deepStrictEqual({
			'M3 думает и выводит рассуждение, лёгкая задача': reasoningScoreOf(caps(m3), light),
			'M3, трудная задача': reasoningScoreOf(caps(m3), demanding),
			'Text-01 не думает, лёгкая задача': reasoningScoreOf(caps(textModel), light),
			'Text-01, трудная задача': reasoningScoreOf(caps(textModel), demanding),
			'GPT-5 думает, не выводит рассуждение': reasoningScoreOf(getModelCapabilities('openAI', 'gpt-5', undefined), demanding),
		}, {
			'M3 думает и выводит рассуждение, лёгкая задача': 0,
			'M3, трудная задача': 17,
			'Text-01 не думает, лёгкая задача': 0,
			'Text-01, трудная задача': -20,
			'GPT-5 думает, не выводит рассуждение': 12,
		});
	});

	/**
	 * Модели MiniMax в списке встроенного провайдера: сначала каталог вендора, потом модели файла
	 * Результаты фактические, не пожелание: думающие модели неразличимы по очкам, порядок между ними держит порядок списка
	 */
	function createMinimaxRouter(modelNames: readonly string[], overridesOfModel: Record<string, unknown> = {}): TaskAwareModelRouter {
		const state = {
			settingsOfProvider: {
				minimax: {
					...defaultSettingsOfProvider.minimax,
					apiKey: 'k',
					_didFillInProviderSettings: true,
					models: modelNames.map(modelName => ({ modelName, type: 'autodetected', isHidden: false })),
				},
			},
			overridesOfModel,
			globalSettings: defaultGlobalSettings,
		} as unknown as VibeideSettingsState;
		const settings = { state, onDidChangeState: Event.None } as unknown as IVibeideSettingsService;
		const disposables = store.add(new DisposableStore());
		return disposables.add(new TaskAwareModelRouter(settings, disposables.add(new InMemoryStorageService())));
	}
	const ranking = (decision: RoutingDecision): string[] => [decision.modelSelection.modelName, ...(decision.fallbackChain ?? []).map(model => model.modelName)];

	/** What the router answers for each kind of task over one model list */
	async function pickedByTask(modelNames: readonly string[]): Promise<Record<string, string[]>> {
		const router = createMinimaxRouter(modelNames);
		return {
			'простой вопрос': ranking(await router.route({ taskType: 'chat', isSimpleQuestion: true })),
			'обычный чат': ranking(await router.route({ taskType: 'chat', preferLowLatency: true })),
			'длинный текст на переписывание': ranking(await router.route({ taskType: 'chat', isLongMessage: true, isDocumentationTask: true, contextSize: 8000 })),
			'код': ranking(await router.route({ taskType: 'code', hasCode: true })),
			'сложный код': ranking(await router.route({ taskType: 'code', hasCode: true, requiresComplexReasoning: true })),
			'несколько шагов': ranking(await router.route({ taskType: 'code', hasCode: true, isMultiStepTask: true })),
			'отладка': ranking(await router.route({ taskType: 'code', hasCode: true, isDebuggingTask: true })),
			'вопрос по кодовой базе': ranking(await router.route({ taskType: 'code', requiresComplexReasoning: true, contextSize: 20000 })),
		};
	}

	test('MiniMax, список как в жизни (каталог, потом модели файла): на трудных задачах отвечает M3, Text-01 последняя', async () => {
		const withTextLast = [m3, m2, flashPreview, textModel];
		assert.deepStrictEqual(await pickedByTask([m3, m2, flashPreview, textModel]), {
			// The fast path takes the first model whose name looks fast («MiniMax» holds «mini») and builds no chain
			'простой вопрос': [m3],
			// A light task gives nobody a bonus for thinking: the four tie, and the order of the list decides
			'обычный чат': withTextLast,
			'длинный текст на переписывание': withTextLast,
			'код': withTextLast,
			'сложный код': withTextLast,
			'несколько шагов': withTextLast,
			'отладка': withTextLast,
			'вопрос по кодовой базе': withTextLast,
		});
	});

	test('MiniMax, модели файла впереди каталога: Text-01 на лёгких задачах впереди, на трудных последняя', async () => {
		const thinkingFirst = [flashPreview, m3, m2, textModel];
		const listOrder = [textModel, flashPreview, m3, m2];
		assert.deepStrictEqual(await pickedByTask([textModel, flashPreview, m3, m2]), {
			// Nothing bans the model: it is available, and the fast path does not weigh anything
			'простой вопрос': [textModel],
			// Nobody gets a bonus for thinking on a light task, so the four tie and the first in the list answers
			'обычный чат': listOrder,
			'длинный текст на переписывание': listOrder,
			'код': thinkingFirst,
			'сложный код': thinkingFirst,
			'несколько шагов': thinkingFirst,
			'отладка': thinkingFirst,
			'вопрос по кодовой базе': thinkingFirst,
		});
	});

	/**
	 * Думающая модель с окном 16K (окно задано настройкой) не получает очков за окно, а Text-01 с окном 1M получает
	 * Раньше бонус за рассуждение (17 очков) на любой задаче держал думающую впереди; теперь на лёгкой задаче его нет
	 * На трудной задаче бонус возвращается: сложный код ведёт думающая
	 */
	test('бонус за рассуждение только на трудной задаче: Text-01 впереди на лёгкой и позади на трудной', async () => {
		const router = createMinimaxRouter([textModel, m2], { minimax: { [m2]: { contextWindow: 16_000 } } });
		assert.deepStrictEqual({
			'обычный чат': ranking(await router.route({ taskType: 'chat', preferLowLatency: true })),
			'длинный текст на переписывание': ranking(await router.route({ taskType: 'chat', isLongMessage: true, isDocumentationTask: true })),
			'сложный код': ranking(await router.route({ taskType: 'code', hasCode: true, requiresComplexReasoning: true })),
		}, {
			'обычный чат': [textModel, m2],
			'длинный текст на переписывание': [textModel, m2],
			'сложный код': [m2, textModel],
		});
	});

	/**
	 * Думающая модель с окном 16K и без вывода рассуждения (оба свойства заданы настройкой)
	 * Очков у неё меньше, чем у Text-01 с окном 1M
	 * Без штрафа Text-01 вела бы на сложном коде; со штрафом ведёт думающая
	 */
	test('штраф переворачивает выбор на трудной задаче: Text-01 против думающей модели с малым окном', async () => {
		const narrowThinker = { contextWindow: 16_000, reasoningCapabilities: { supportsReasoning: true, canTurnOffReasoning: false, canIOReasoning: false } };
		const router = createMinimaxRouter([textModel, m2], { minimax: { [m2]: narrowThinker } });
		assert.deepStrictEqual(ranking(await router.route({ taskType: 'code', hasCode: true, requiresComplexReasoning: true })), [m2, textModel]);
	});

	test('единственная доступная модель без рассуждения отвечает и на трудной задаче: штраф не запрет', async () => {
		const router = createMinimaxRouter([textModel]);
		assert.deepStrictEqual([
			ranking(await router.route({ taskType: 'code', hasCode: true, requiresComplexReasoning: true })),
			ranking(await router.route({ taskType: 'chat', isLongMessage: true })),
		], [[textModel], [textModel]]);
	});
});
