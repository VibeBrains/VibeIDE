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
import { retiredForAutoPick } from '../../common/modelDeprecation.js';
import { TaskAwareModelRouter } from '../../common/modelRouter.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../../common/vibeideSettingsService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider } from '../../common/vibeideSettingsTypes.js';

/**
 * Автовыбор — единственное место, где модель выбирает не человек, поэтому выключенную вендором модель он не отдаёт
 * Llama у Groq выключены 16.08.2026 для всех, кроме enterprise-контрактов: руками её выбрать можно, автоматически — нет
 */
suite('автовыбор не отдаёт модель, которую вендор уже выключил', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const retired = 'llama-3.1-8b-instant';
	const successor = 'openai/gpt-oss-20b';

	test('пометка у встроенной модели: выключенная исключается, преемник и модель без пометки — нет', () => {
		const now = Date.UTC(2026, 8, 30);
		assert.deepStrictEqual(
			[retired, successor].map(modelName => retiredForAutoPick(getModelCapabilities('groq', modelName, undefined), now)),
			[true, false],
		);
		// Before the vendor's date the model is only announced: a reason to warn, not to take it away
		assert.strictEqual(retiredForAutoPick(getModelCapabilities('groq', retired, undefined), Date.UTC(2026, 7, 1)), false);
	});

	/**
	 * Роутер «Авто» собирает кандидатов сам, и его поздние стадии откатываются к «всем моделям», когда фильтр опустошил
	 * список. Выключенная отсекается на источнике: ни быстрый путь, ни взвешивание, ни запасная цепочка её не видят
	 * Выключенная стоит первой и по имени быстрая (`8b`) — ровно та, что взял бы быстрый путь
	 */
	test('роутер «Авто»: ни быстрый путь, ни взвешивание, ни запасная цепочка не берут выключенную', async () => {
		const state = {
			settingsOfProvider: {
				groq: {
					...defaultSettingsOfProvider.groq,
					apiKey: 'k',
					_didFillInProviderSettings: true,
					models: [retired, successor].map(modelName => ({ modelName, type: 'default', isHidden: false })),
				},
			},
			overridesOfModel: {},
			globalSettings: defaultGlobalSettings,
		} as unknown as VibeideSettingsState;
		const settings = { state, onDidChangeState: Event.None } as unknown as IVibeideSettingsService;
		const disposables = store.add(new DisposableStore());
		const router = disposables.add(new TaskAwareModelRouter(settings, disposables.add(new InMemoryStorageService())));
		const picked = async (context: Parameters<TaskAwareModelRouter['route']>[0]) => {
			const decision = await router.route(context);
			return [decision.modelSelection.modelName, ...(decision.fallbackChain ?? []).map(model => model.modelName)];
		};
		assert.deepStrictEqual([
			await picked({ taskType: 'chat', isSimpleQuestion: true }),
			await picked({ taskType: 'code', hasCode: true, requiresComplexReasoning: true }),
		], [
			[successor],
			[successor],
		]);
	});
});
