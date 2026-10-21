/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// OpenCode Go вышел из встроенных провайдеров и подключается файлом общего набора. Здесь стерегутся четыре вещи:
// порядок встроенных (MiniMax, DeepSeek, затем Zen), перенос настроек тех, кто Go уже использовал,
// общий ключ Go и Zen через слот `opencode` и заголовки клиента для шлюза opencode.ai у провайдера из файла.

import * as assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IEncryptionService, KnownStorageProvider } from '../../../../../platform/encryption/common/encryptionService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { IMetricsService } from '../../common/metricsService.js';
import { defaultProviderSettings } from '../../common/modelCapabilities.js';
import { matchQuirks } from '../../common/modelQuirks/modelQuirksTypes.js';
import { LEGACY_OPENCODE_GO_ID, migrateOpenCodeGoState, OPENCODE_GO_CONFIG_ID, OpenCodeGoMigratableState, openCodeGoMigrationWorthMentioning } from '../../common/openCodeGoMigration.js';
import { isOpencodeGatewayUrl, opencodeGatewayHeaders } from '../../common/opencodeGateway.js';
import { OPENCODE_GO_MIGRATION_NOTICE_KEY, VOID_SETTINGS_STORAGE_KEY } from '../../common/storageKeys.js';
import { VoidSettingsService } from '../../common/vibeideSettingsService.js';
import { apiKeySlotOfRef, autoModelFallbackProviderOrder, defaultSettingsOfProvider, providerNames } from '../../common/vibeideSettingsTypes.js';

suite('OpenCode Go — вышел из встроенных провайдеров', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('встроенных нет с id OpenCode Go ни в одной таблице, id остальных уникальны', () => {
		assert.deepStrictEqual(
			{
				inNames: providerNames.includes(LEGACY_OPENCODE_GO_ID as never),
				inDefaults: LEGACY_OPENCODE_GO_ID in defaultProviderSettings,
				inSettings: LEGACY_OPENCODE_GO_ID in defaultSettingsOfProvider,
				inAuto: (autoModelFallbackProviderOrder as readonly string[]).includes(LEGACY_OPENCODE_GO_ID),
				unique: new Set(providerNames).size === providerNames.length,
			},
			{ inNames: false, inDefaults: false, inSettings: false, inAuto: false, unique: true },
		);
	});

	test('порядок встроенных: MiniMax первым, DeepSeek вторым, OpenCode Zen после них — и в настройках, и в «Авто»', () => {
		assert.deepStrictEqual(
			{ settings: providerNames.slice(0, 3), auto: autoModelFallbackProviderOrder.slice(0, 3) },
			{ settings: ['minimax', 'deepseek', 'openCodeZen'], auto: ['minimax', 'deepseek', 'openCodeZen'] },
		);
	});

	test('«Авто» знает ровно встроенных провайдеров: ни лишних, ни пропавших', () => {
		assert.deepStrictEqual(
			{
				missing: providerNames.filter(name => !(autoModelFallbackProviderOrder as readonly string[]).includes(name) && !['googleVertex', 'microsoftAzure', 'awsBedrock', 'lmRoute'].includes(name)),
				unknown: (autoModelFallbackProviderOrder as readonly string[]).filter(name => !(providerNames as readonly string[]).includes(name)),
			},
			{ missing: [], unknown: [] },
		);
	});

	suite('перенос настроек', () => {

		const used = (): OpenCodeGoMigratableState => ({
			settingsOfProvider: {
				openCodeGo: { apiKey: 'sk-go-123', models: [{ modelName: 'qwen3.6-plus', isHidden: false }, { modelName: 'kimi-k2.6', isHidden: true }] },
				openCodeZen: { apiKey: 'sk-zen-1', models: [] },
			},
			modelSelectionOfFeature: { Chat: { providerName: LEGACY_OPENCODE_GO_ID, modelName: 'qwen3.6-plus' }, 'Ctrl+K': { providerName: 'anthropic', modelName: 'claude' }, Apply: null },
			modelSelectionOfRole: { reviewer: { providerName: LEGACY_OPENCODE_GO_ID, modelName: 'kimi-k2.6' } },
			optionsOfModelSelection: { Chat: { openCodeGo: { 'qwen3.6-plus': { reasoningEffort: 'high' } }, anthropic: {} } },
			overridesOfModel: { openCodeGo: { 'qwen3.6-plus': { contextWindow: 100000 } }, anthropic: {} },
		});

		test('ключ, выбор модели, роли, параметры и правки моделей уходят к провайдеру из файла', () => {
			const state = used();
			const report = migrateOpenCodeGoState(state);
			assert.deepStrictEqual(
				{
					report,
					key: state.dynamicProviderApiKeys,
					visible: state.dynamicModelHidden,
					goLeft: state.settingsOfProvider && LEGACY_OPENCODE_GO_ID in state.settingsOfProvider,
					zenKept: state.settingsOfProvider?.openCodeZen?.apiKey,
					chat: state.modelSelectionOfFeature?.Chat,
					other: state.modelSelectionOfFeature?.['Ctrl+K'],
					role: state.modelSelectionOfRole?.reviewer,
					options: state.optionsOfModelSelection?.Chat,
					overrides: state.overridesOfModel,
				},
				{
					report: { movedKey: true, movedSelections: 2, movedVisibleModels: 1 },
					key: { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' },
					visible: { [OPENCODE_GO_CONFIG_ID]: { 'qwen3.6-plus': false } },
					goLeft: false,
					zenKept: 'sk-zen-1',
					chat: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' },
					other: { providerName: 'anthropic', modelName: 'claude' },
					role: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'kimi-k2.6' },
					options: { anthropic: {}, [OPENCODE_GO_CONFIG_ID]: { 'qwen3.6-plus': { reasoningEffort: 'high' } } },
					overrides: { anthropic: {}, [OPENCODE_GO_CONFIG_ID]: { 'qwen3.6-plus': { contextWindow: 100000 } } },
				},
			);
		});

		test('повторный перенос ничего не делает', () => {
			const state = used();
			migrateOpenCodeGoState(state);
			const snapshot = JSON.stringify(state);
			assert.deepStrictEqual([migrateOpenCodeGoState(state), JSON.stringify(state) === snapshot], [undefined, true]);
		});

		test('ключ, уже введённый у провайдера из файла, не затирается', () => {
			const state = used();
			state.dynamicProviderApiKeys = { [OPENCODE_GO_CONFIG_ID]: 'sk-already-typed' };
			const report = migrateOpenCodeGoState(state);
			assert.deepStrictEqual([report?.movedKey, state.dynamicProviderApiKeys[OPENCODE_GO_CONFIG_ID]], [false, 'sk-already-typed']);
		});

		test('пустой встроенный провайдер (стартовое значение) переносить нечего и говорить об этом не нужно', () => {
			const fresh: OpenCodeGoMigratableState = {
				settingsOfProvider: { openCodeGo: { apiKey: '', models: [{ modelName: 'qwen3.6-plus', isHidden: true }] } },
				modelSelectionOfFeature: { Chat: null },
			};
			const report = migrateOpenCodeGoState(fresh);
			assert.deepStrictEqual(
				{ report, mention: openCodeGoMigrationWorthMentioning(report), left: fresh.settingsOfProvider && LEGACY_OPENCODE_GO_ID in fresh.settingsOfProvider },
				{ report: { movedKey: false, movedSelections: 0, movedVisibleModels: 0 }, mention: false, left: false },
			);
		});

		test('состояние без OpenCode Go (свежий профиль) отчёта не даёт', () => {
			assert.strictEqual(migrateOpenCodeGoState({ settingsOfProvider: { openCodeZen: { apiKey: '' } }, modelSelectionOfFeature: {} }), undefined);
		});

		test('выбор, оставшийся на Go без ключа, тоже переезжает: провайдер появится, когда файл будет прочитан', () => {
			const state: OpenCodeGoMigratableState = {
				settingsOfProvider: { openCodeGo: { apiKey: '', models: [] } },
				modelSelectionOfFeature: { Chat: { providerName: LEGACY_OPENCODE_GO_ID, modelName: 'minimax-m3' } },
			};
			const report = migrateOpenCodeGoState(state);
			assert.deepStrictEqual(
				[state.modelSelectionOfFeature?.Chat, openCodeGoMigrationWorthMentioning(report)],
				[{ providerName: OPENCODE_GO_CONFIG_ID, modelName: 'minimax-m3' }, true],
			);
		});
	});

	suite('перенос при чтении настроек сервисом', () => {

		const store = new DisposableStore();
		teardown(() => store.clear());

		// Шифрование подменено тождественным: проверяется порядок «прочитал → перенёс → сохранил → оставил отметку для уведомления»
		const encryption: IEncryptionService = {
			_serviceBrand: undefined,
			encrypt: async (value: string) => value,
			decrypt: async (value: string) => value,
			isEncryptionAvailable: async () => true,
			getKeyStorageProvider: async () => KnownStorageProvider.basicText,
			setUsePlainTextEncryption: async () => { },
		};
		const metrics = { capture: () => { }, setOptOut: () => { }, getDebuggingProperties: async () => ({}) } as unknown as IMetricsService;

		const startService = async (stored: object | undefined) => {
			const storage = store.add(new TestStorageService());
			if (stored) {
				storage.store(VOID_SETTINGS_STORAGE_KEY, JSON.stringify(stored), StorageScope.APPLICATION, StorageTarget.USER);
			}
			const service = store.add(new VoidSettingsService(storage, encryption, metrics, new TestConfigurationService()));
			await service.waitForInitState;
			// Сохранение идёт сразу после того, как состояние объявлено готовым
			await timeout(0);
			return { service, storage };
		};
		const storedState = (storage: TestStorageService) => JSON.parse(storage.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)!);

		// Пустой SCM при чтении берёт выбор Chat (старая миграция 1.3.5), поэтому переезжают два выбора, а не один
		test('у пользователя Go перенос доходит до хранилища, а отметка для уведомления ждёт окна', async () => {
			const { service, storage } = await startService({
				globalSettings: {},
				settingsOfProvider: { openCodeGo: { apiKey: 'sk-go-123', models: [{ modelName: 'qwen3.6-plus', isHidden: false, type: 'custom' }] } },
				modelSelectionOfFeature: { Chat: { providerName: LEGACY_OPENCODE_GO_ID, modelName: 'qwen3.6-plus' }, 'Ctrl+K': null, Autocomplete: null, Apply: null, SCM: null },
				optionsOfModelSelection: { Chat: {}, 'Ctrl+K': {}, Autocomplete: {}, Apply: {}, SCM: {} },
			});
			const persisted = storedState(storage);
			assert.deepStrictEqual(
				{
					memory: {
						goLeft: LEGACY_OPENCODE_GO_ID in service.state.settingsOfProvider,
						key: service.state.dynamicProviderApiKeys,
						chat: service.state.modelSelectionOfFeature.Chat,
						scm: service.state.modelSelectionOfFeature.SCM,
					},
					persisted: {
						goLeft: LEGACY_OPENCODE_GO_ID in persisted.settingsOfProvider,
						key: persisted.dynamicProviderApiKeys,
						chat: persisted.modelSelectionOfFeature.Chat,
					},
					notice: JSON.parse(storage.get(OPENCODE_GO_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION)!),
				},
				{
					memory: { goLeft: false, key: { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' }, chat: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' }, scm: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' } },
					persisted: { goLeft: false, key: { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' }, chat: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' } },
					notice: { movedKey: true, movedSelections: 2, movedVisibleModels: 1 },
				},
			);
		});

		test('второй запуск на уже перенесённом состоянии уведомления не оставляет, ключ остаётся на месте', async () => {
			const first = await startService({
				globalSettings: {},
				settingsOfProvider: { openCodeGo: { apiKey: 'sk-go-123', models: [] } },
				modelSelectionOfFeature: { Chat: null },
				optionsOfModelSelection: { Chat: {} },
			});
			const afterFirst = first.storage.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)!;
			first.storage.remove(OPENCODE_GO_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION);

			const second = new TestStorageService();
			store.add(second);
			second.store(VOID_SETTINGS_STORAGE_KEY, afterFirst, StorageScope.APPLICATION, StorageTarget.USER);
			store.add(new VoidSettingsService(second, encryption, metrics, new TestConfigurationService()));
			await timeout(0);
			assert.deepStrictEqual(
				[second.get(OPENCODE_GO_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION), JSON.parse(second.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)!).dynamicProviderApiKeys],
				[undefined, { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' }],
			);
		});

		test('свежий профиль и пользователь без Go: уведомления нет, ключей у провайдера из файла нет', async () => {
			const fresh = await startService(undefined);
			const empty = await startService({
				globalSettings: {},
				settingsOfProvider: { openCodeGo: { apiKey: '', models: [] } },
				modelSelectionOfFeature: { Chat: null },
				optionsOfModelSelection: { Chat: {} },
			});
			assert.deepStrictEqual(
				[fresh, empty].map(({ service, storage }) => ({
					notice: storage.get(OPENCODE_GO_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION),
					keys: service.state.dynamicProviderApiKeys,
					goLeft: LEGACY_OPENCODE_GO_ID in service.state.settingsOfProvider,
				})),
				[
					{ notice: undefined, keys: {}, goLeft: false },
					{ notice: undefined, keys: {}, goLeft: false },
				],
			);
		});
	});

	test('слот ключа `opencode` из набора — это ключ встроенного Zen; остальные ссылки на ключ не меняются', () => {
		assert.deepStrictEqual(
			['opencode', 'OpenCode', 'opencode-zen', 'openCodeZen', 'minimax', 'google-gemini', 'meta-muse'].map(apiKeySlotOfRef),
			['openCodeZen', 'openCodeZen', 'openCodeZen', 'openCodeZen', 'minimax', 'google-gemini', 'meta-muse'],
		);
	});

	test('шлюз opencode.ai узнаёт клиента: заголовки добавляются по адресу, а не по id провайдера', () => {
		const ids = { project: 'vibeide-project', session: 'vibeide-session', request: 'request-1' };
		assert.deepStrictEqual(
			{
				go: isOpencodeGatewayUrl('https://opencode.ai/zen/go/v1'),
				zen: isOpencodeGatewayUrl('https://opencode.ai/zen/v1'),
				lookalike: isOpencodeGatewayUrl('https://opencode.ai.evil.example/zen/v1'),
				other: isOpencodeGatewayUrl('https://api.minimax.io/v1'),
				broken: [undefined, '', 'не адрес'].map(isOpencodeGatewayUrl),
				headers: opencodeGatewayHeaders(ids),
			},
			{
				go: true,
				zen: true,
				lookalike: false,
				other: false,
				broken: [false, false, false],
				headers: {
					'User-Agent': 'opencode/0.13.0',
					'x-opencode-client': 'vibeide',
					'x-opencode-project': 'vibeide-project',
					'x-opencode-session': 'vibeide-session',
					'x-opencode-request': 'request-1',
				},
			},
		);
	});

	test('причуды моделей через OpenCode одинаковы у встроенного Zen и у провайдера Go из файла: правила привязаны к подстроке «opencode»', () => {
		const rules = [
			{ match: 'kimi', provider: 'openCode', forceToolCallFormat: 'auto' as const, temperature: 1.0 },
			{ match: 'minimax', provider: 'openCode', forceToolCallFormat: 'auto' as const, temperature: 1.0 },
		];
		const quirksOf = (model: string, provider: string) => matchQuirks(rules, model, provider);
		assert.deepStrictEqual(
			[quirksOf('kimi-k2.6', 'openCodeZen'), quirksOf('kimi-k2.6', 'opencode-go'), quirksOf('minimax-m3', 'opencode-go')],
			[quirksOf('kimi-k2.6', 'openCodeZen'), { forceToolCallFormat: 'auto', temperature: 1.0 }, { forceToolCallFormat: 'auto', temperature: 1.0 }],
		);
	});
});
