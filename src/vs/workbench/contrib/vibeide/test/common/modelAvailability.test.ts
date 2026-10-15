/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { ModelAvailabilityRegistry, providerSetupKey, UNAVAILABLE_MARK_TTL_MS } from '../../common/modelAvailability.js';
import { nextAutoFallback, RoutingDecision, TaskAwareModelRouter, TaskContext } from '../../common/modelRouter.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../../common/vibeideSettingsService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider, ModelSelection, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { vibeLog } from '../../common/vibeLog.js';

const gpt5: ModelSelection = { providerName: 'openAI', modelName: 'gpt-5' };
const gpt5Mini: ModelSelection = { providerName: 'openAI', modelName: 'gpt-5-mini' };
const sonnet: ModelSelection = { providerName: 'anthropic', modelName: 'claude-sonnet-4' };
const key = 'setup-1';
const t0 = Date.UTC(2026, 9, 15, 12, 0, 0);

/**
 * Модель, которую ошибка показала закрытой для человека («Авто» её больше не берёт), помнит реестр
 * Он не знает про сервисы и часы: время приходит параметром
 */
suite('реестр закрытых для человека моделей', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const held = (registry: ModelAvailabilityRegistry, model: ModelSelection, setupKey = key, now = t0) =>
		registry.unavailabilityOf(model, () => setupKey, now);

	test('отметка модели закрывает только её, отметка провайдера — все его модели', () => {
		const registry = new ModelAvailabilityRegistry();
		registry.mark(gpt5, { scope: 'model', reason: 'region' }, key, t0);
		assert.deepStrictEqual([held(registry, gpt5), held(registry, gpt5Mini), held(registry, sonnet)], [
			{ scope: 'model', reason: 'region' }, undefined, undefined,
		]);
		registry.mark(gpt5Mini, { scope: 'provider', reason: 'quota' }, key, t0);
		assert.deepStrictEqual([held(registry, gpt5Mini), held(registry, { providerName: 'openAI', modelName: 'o3' }), held(registry, sonnet)], [
			{ scope: 'provider', reason: 'quota' }, { scope: 'provider', reason: 'quota' }, undefined,
		]);
	});

	test('отметка снимается ответом модели, сменой ключа провайдера и сроком', () => {
		const registry = new ModelAvailabilityRegistry();
		registry.mark(gpt5, { scope: 'model', reason: 'access' }, key, t0);
		assert.deepStrictEqual([
			held(registry, gpt5, key, t0 + UNAVAILABLE_MARK_TTL_MS - 1)?.reason,
			held(registry, gpt5, 'setup-2', t0 + 1),
		], ['access', undefined]);
		// The hold lifted by a new key does not come back with the old one
		assert.strictEqual(held(registry, gpt5, key, t0 + 2), undefined);

		registry.mark(gpt5, { scope: 'model', reason: 'access' }, key, t0);
		assert.strictEqual(held(registry, gpt5, key, t0 + UNAVAILABLE_MARK_TTL_MS), undefined);

		// An answer from any model of the provider shows its quota is no longer spent
		registry.mark(gpt5, { scope: 'model', reason: 'region' }, key, t0);
		registry.mark(gpt5, { scope: 'provider', reason: 'quota' }, key, t0);
		assert.deepStrictEqual([registry.clear(gpt5Mini), held(registry, gpt5), registry.clear(gpt5), held(registry, gpt5), registry.clear(gpt5)], [
			true, { scope: 'model', reason: 'region' }, true, undefined, false,
		]);
	});

	test('ключ настройки провайдера зависит от ключа доступа и адреса, а не от списка моделей и проверки ключа', () => {
		// openAICompatible has an address of its own; OpenAI proper is reached by the key alone
		const settings = (patch: Record<string, unknown>) => ({
			openAICompatible: { ...defaultSettingsOfProvider.openAICompatible, apiKey: 'k1', endpoint: 'https://a.example/v1', _didFillInProviderSettings: true, models: [], ...patch },
		}) as unknown as SettingsOfProvider;
		const keyOf = (patch: Record<string, unknown>) => providerSetupKey(settings(patch), 'openAICompatible');
		assert.deepStrictEqual({
			'тот же ключ, другой список моделей': keyOf({ models: [{ modelName: 'm', type: 'default', isHidden: false }] }) === keyOf({}),
			'тот же ключ, проверка ключа закончилась': keyOf({ keyStatus: 'valid' }) === keyOf({ keyStatus: 'pending' }),
			'другой ключ доступа': keyOf({ apiKey: 'k2' }) === keyOf({}),
			'другой адрес': keyOf({ endpoint: 'https://b.example/v1' }) === keyOf({}),
			// A file provider spelled `openai` patches the built-in `openAI`: its key is read from the built-in's fields
			'провайдер из файла под строчным именем': providerSetupKey({ openai: { apiKey: 'k1', models: [] } } as unknown as SettingsOfProvider, 'openai')
				=== providerSetupKey({ openAI: { apiKey: 'k1', models: [] } } as unknown as SettingsOfProvider, 'openAI'),
			'провайдера нет в настройках': typeof providerSetupKey({} as SettingsOfProvider, 'gone'),
		}, {
			'тот же ключ, другой список моделей': true,
			'тот же ключ, проверка ключа закончилась': true,
			'другой ключ доступа': false,
			'другой адрес': false,
			'провайдер из файла под строчным именем': true,
			'провайдера нет в настройках': 'string',
		});
	});

	test('запасная модель: не опробованная, не с упавшего провайдера и не закрытая ошибкой', () => {
		const ranking = [gpt5, gpt5Mini, sonnet];
		const skips = (patch: Partial<Parameters<typeof nextAutoFallback>[1]> = {}) => ({
			tried: new Set<string>(),
			providersDown: new Set<string>(),
			isUnavailable: () => false,
			...patch,
		});
		assert.deepStrictEqual([
			nextAutoFallback(ranking, skips()),
			nextAutoFallback(ranking, skips({ tried: new Set(['openAI/gpt-5']) })),
			nextAutoFallback(ranking, skips({ tried: new Set(['openAI/gpt-5']), providersDown: new Set(['openAI']) })),
			nextAutoFallback(ranking, skips({ isUnavailable: model => model.modelName === 'gpt-5' || model.modelName === 'gpt-5-mini' })),
			nextAutoFallback(ranking, skips({ tried: new Set(['openAI/gpt-5', 'openAI/gpt-5-mini', 'anthropic/claude-sonnet-4']) })),
			nextAutoFallback(undefined, skips()),
		], [gpt5, gpt5Mini, sonnet, sonnet, undefined, undefined]);
	});
});

/**
 * Роутер «Авто» не берёт закрытую ошибкой модель ни на быстром пути, ни при взвешивании, ни в запасной цепочке
 * Отметку ставит чат (`reportUnavailable`), снимает ответ модели
 */
suite('роутер «Авто» и закрытые ошибкой модели', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The router logs a hold through `vibeLog`, and the runner fails any test that writes to the console
	setup(() => vibeLog.configure({ enabled: false }));
	teardown(() => vibeLog.configure({ enabled: true }));

	const openAiModels = ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'gpt-4o'];

	/** A router over OpenAI and Anthropic; the state is returned so a test can change the key as the user does */
	function createRouter(models: { readonly openAI: readonly string[]; readonly anthropic: readonly string[] }) {
		const withModels = (providerName: 'openAI' | 'anthropic') => ({
			...defaultSettingsOfProvider[providerName],
			apiKey: 'k1',
			_didFillInProviderSettings: true,
			models: models[providerName].map(modelName => ({ modelName, type: 'default', isHidden: false })),
		});
		const state = {
			settingsOfProvider: { openAI: withModels('openAI'), anthropic: withModels('anthropic') },
			overridesOfModel: {},
			globalSettings: defaultGlobalSettings,
		} as unknown as VibeideSettingsState;
		const settings = { state, onDidChangeState: Event.None } as unknown as IVibeideSettingsService;
		const disposables = store.add(new DisposableStore());
		const router = disposables.add(new TaskAwareModelRouter(settings, disposables.add(new InMemoryStorageService())));
		return { router, state };
	}

	const ranking = (decision: RoutingDecision): string[] =>
		[decision.modelSelection, ...(decision.fallbackChain ?? [])].map(model => `${model.providerName}/${model.modelName}`);
	const openAi = (modelName: string): ModelSelection => ({ providerName: 'openAI', modelName });
	const complex: TaskContext = { taskType: 'general', requiresComplexReasoning: true };

	test('взвешивание и цепочка: закрытая модель выпадает, остальные сохраняют порядок', async () => {
		const { router } = createRouter({ openAI: openAiModels, anthropic: [] });
		const before = ranking(await router.route(complex));
		assert.strictEqual(before.length, 4);
		// A hold on the runner-up reaches the decision made a moment ago: the routing cache is dropped with the mark
		router.reportUnavailable(openAi(before[1].split('/')[1]), { scope: 'model', reason: 'region' });
		const after = ranking(await router.route(complex));
		assert.deepStrictEqual(after.slice(0, 2), [before[0], before[2]]);
		assert.ok(!after.includes(before[1]));
		// The model that led is held back: the next one takes the lead
		router.reportUnavailable(openAi(before[0].split('/')[1]), { scope: 'model', reason: 'access' });
		const lead = ranking(await router.route(complex));
		assert.ok(!lead.includes(before[0]) && !lead.includes(before[1]));
		assert.strictEqual(lead[0], before[2]);
	});

	test('быстрый путь на простом вопросе: закрытая мини-модель не берётся, берётся следующая', async () => {
		const { router } = createRouter({ openAI: ['gpt-5-mini', 'gpt-5-nano'], anthropic: [] });
		const simple: TaskContext = { taskType: 'chat', isSimpleQuestion: true };
		const picked = async () => (await router.route(simple)).modelSelection.modelName;
		const first = await picked();
		router.reportUnavailable(openAi(first), { scope: 'model', reason: 'region' });
		const second = await picked();
		assert.deepStrictEqual([first, second], ['gpt-5-mini', 'gpt-5-nano']);
	});

	test('квота закрывает провайдера целиком: его моделей нет ни среди выбранных, ни среди запасных', async () => {
		const { router } = createRouter({ openAI: openAiModels, anthropic: ['claude-sonnet-4', 'claude-opus-4'] });
		router.reportUnavailable(openAi('gpt-5'), { scope: 'provider', reason: 'quota' });
		const held = ranking(await router.route(complex));
		assert.ok(held.length > 0 && held.every(entry => entry.startsWith('anthropic/')), held.join(', '));
		assert.ok(router.isUnavailable(openAi('gpt-4o')) && !router.isUnavailable({ providerName: 'anthropic', modelName: 'claude-opus-4' }));
	});

	test('ответ модели, новый ключ провайдера и закрытие только одной модели снимают или не трогают отметку', async () => {
		const { router, state } = createRouter({ openAI: openAiModels, anthropic: [] });
		const before = ranking(await router.route(complex));
		router.reportUnavailable(openAi('gpt-5'), { scope: 'model', reason: 'access' });
		router.reportUnavailable(openAi('gpt-5-mini'), { scope: 'model', reason: 'access' });
		assert.deepStrictEqual([router.isUnavailable(openAi('gpt-5')), router.isUnavailable(openAi('gpt-5-mini')), router.isUnavailable(openAi('o3'))], [true, true, false]);

		// The model answered: its own hold is lifted, the other one stays
		router.reportAvailable(openAi('gpt-5'));
		assert.deepStrictEqual([router.isUnavailable(openAi('gpt-5')), router.isUnavailable(openAi('gpt-5-mini'))], [false, true]);

		// The user typed a new key: nothing about the old one holds
		(state.settingsOfProvider.openAI as { apiKey: string }).apiKey = 'k2';
		assert.strictEqual(router.isUnavailable(openAi('gpt-5-mini')), false);
		assert.deepStrictEqual(ranking(await router.route(complex)), before);
	});

	test('ручной выбор закрытой модели роутер не трогает: руками выбирает человек', async () => {
		const { router } = createRouter({ openAI: openAiModels, anthropic: [] });
		router.reportUnavailable(openAi('gpt-5'), { scope: 'model', reason: 'region' });
		const decision = await router.route({ ...complex, userOverride: openAi('gpt-5') });
		assert.deepStrictEqual([decision.source, decision.modelSelection.modelName], ['manual', 'gpt-5']);
	});
});
