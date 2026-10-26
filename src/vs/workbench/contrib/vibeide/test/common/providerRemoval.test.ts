/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Вырезанные встроенные провайдеры (OpenCode Go, Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Pollinations, Vertex, Azure,
// Bedrock, «Совместимо с OpenAI API») переехали к провайдерам из файлов набора. Здесь стерегутся: список встроенных и порядок,
// перенос настроек тех, кто этими провайдерами пользовался (чистая функция и сервис настроек поверх хранилища),
// общий ключ Go и Zen через слот `opencode`, заголовки клиента для шлюза opencode.ai и причуды моделей через OpenCode.

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
import { CONFIG_ID_OF_VENDOR, PROVIDER_VENDORS } from '../../common/providerVendor.js';
import { LEGACY_PROVIDER_MOVES, migrateLegacyProviders, MIGRATED_PROVIDER_FILES, ProviderMigratableState, providerMigrationWorthMentioning } from '../../common/providerMigration.js';
import { isOpencodeGatewayUrl, opencodeGatewayHeaders } from '../../common/opencodeGateway.js';
import { PROVIDER_FILES_MIGRATION_KEY, PROVIDER_MIGRATION_NOTICE_KEY, VOID_SETTINGS_STORAGE_KEY } from '../../common/storageKeys.js';
import { VoidSettingsService, withFileProviderSeeds } from '../../common/vibeideSettingsService.js';
import { apiKeySlotOfRef, autoFallbackProviderIds, autoModelFallbackProviderOrder, defaultSettingsOfProvider, providerNames, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';

/** Прежние id всех вырезанных встроенных провайдеров. */
const REMOVED_BUILTIN_IDS = LEGACY_PROVIDER_MOVES.map(move => move.legacyId);
const OPENCODE_GO_CONFIG_ID = 'opencode-go';

suite('Вырезанные встроенные провайдеры — теперь провайдеры из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('вырезанных нет ни в одной таблице встроенных, id остальных уникальны', () => {
		assert.deepStrictEqual(
			{
				inNames: REMOVED_BUILTIN_IDS.filter(id => (providerNames as readonly string[]).includes(id)),
				inDefaults: REMOVED_BUILTIN_IDS.filter(id => Object.hasOwn(defaultProviderSettings, id)),
				inSettings: REMOVED_BUILTIN_IDS.filter(id => Object.hasOwn(defaultSettingsOfProvider, id)),
				unique: new Set(providerNames).size === providerNames.length,
			},
			{ inNames: [], inDefaults: [], inSettings: [], unique: true },
		);
	});

	test('встроенными остались ровно MiniMax, DeepSeek, OpenCode Zen, OpenRouter, LM Router, LiteLLM и локальные', () => {
		assert.deepStrictEqual(
			[...providerNames].sort(),
			['deepseek', 'liteLLM', 'lmRoute', 'lmStudio', 'minimax', 'ollama', 'openCodeZen', 'openRouter', 'vLLM'],
		);
	});

	test('порядок встроенных: MiniMax первым, DeepSeek вторым, OpenCode Zen после них — и в настройках, и в «Авто»', () => {
		assert.deepStrictEqual(
			{ settings: providerNames.slice(0, 3), auto: autoModelFallbackProviderOrder.slice(0, 3) },
			{ settings: ['minimax', 'deepseek', 'openCodeZen'], auto: ['minimax', 'deepseek', 'openCodeZen'] },
		);
	});

	test('«Авто» знает всех встроенных, кроме LM Router, и провайдеров из набора вместо вырезанных; прежний порядок сохранён', () => {
		const fromSet = [CONFIG_ID_OF_VENDOR.anthropic, CONFIG_ID_OF_VENDOR.openAI, CONFIG_ID_OF_VENDOR.gemini, CONFIG_ID_OF_VENDOR.xAI, CONFIG_ID_OF_VENDOR.mistral, CONFIG_ID_OF_VENDOR.groq];
		assert.deepStrictEqual(
			{
				missingBuiltins: providerNames.filter(name => !(autoModelFallbackProviderOrder as readonly string[]).includes(name) && name !== 'lmRoute'),
				// Прежний id, который у файла набора пишется иначе (`openAI` → `openai`), в порядке «Авто» остаться не должен
				removedIdsLeft: LEGACY_PROVIDER_MOVES.filter(move => move.legacyId !== move.configId && (autoModelFallbackProviderOrder as readonly string[]).includes(move.legacyId)).map(move => move.legacyId),
				order: autoModelFallbackProviderOrder,
			},
			{
				missingBuiltins: [],
				removedIdsLeft: [],
				order: ['minimax', 'deepseek', 'openCodeZen', ...fromSet, 'ollama', 'vLLM', 'lmStudio', 'openai-compatible', 'openRouter', 'liteLLM', 'pollinations'],
			},
		);
	});

	test('кандидаты «Авто»: чужие файловые провайдеры впереди, а Anthropic, OpenAI и прочие идут на своих прежних местах', () => {
		const settings = { kimi: {}, anthropic: {}, openai: {}, minimax: {}, 'my-proxy': {} } as unknown as SettingsOfProvider;
		const ids = autoFallbackProviderIds(settings);
		assert.deepStrictEqual(
			{ head: ids.slice(0, 2), minimaxBeforeAnthropic: ids.indexOf('minimax') < ids.indexOf('anthropic'), anthropicBeforeOpenai: ids.indexOf('anthropic') < ids.indexOf('openai') },
			{ head: ['kimi', 'my-proxy'], minimaxBeforeAnthropic: true, anthropicBeforeOpenai: true },
		);
	});

	test('сиды файловых провайдеров идут после встроенных в порядке оверлея, а устаревшие сиды не остаются', () => {
		const current = { minimax: { a: 1 }, deepseek: { a: 2 }, 'old-file': { a: 3 }, anthropic: { a: 4 } };
		const overlay = { kimi: { b: 1 }, anthropic: { b: 2 }, 'my-proxy': { b: 3 } };
		const merged = withFileProviderSeeds(current, overlay);
		assert.deepStrictEqual(
			{ order: Object.keys(merged), anthropic: (merged as Record<string, unknown>).anthropic },
			{ order: ['minimax', 'deepseek', 'kimi', 'anthropic', 'my-proxy'], anthropic: { b: 2 } },
		);
		// Без оверлея остаются одни встроенные: провайдер, удалённый из файлов, из списка уходит
		assert.deepStrictEqual(Object.keys(withFileProviderSeeds(current, undefined)), ['minimax', 'deepseek']);
	});

	suite('перенос настроек', () => {

		const used = (): ProviderMigratableState => ({
			settingsOfProvider: {
				openCodeGo: { apiKey: 'sk-go-123', models: [{ modelName: 'qwen3.6-plus', isHidden: false }, { modelName: 'kimi-k2.6', isHidden: true }] },
				openCodeZen: { apiKey: 'sk-zen-1', models: [] },
			},
			modelSelectionOfFeature: { Chat: { providerName: 'openCodeGo', modelName: 'qwen3.6-plus' }, 'Ctrl+K': { providerName: 'minimax', modelName: 'MiniMax-M3' }, Apply: null },
			modelSelectionOfRole: { reviewer: { providerName: 'openCodeGo', modelName: 'kimi-k2.6' } },
			optionsOfModelSelection: { Chat: { openCodeGo: { 'qwen3.6-plus': { reasoningEffort: 'high' } }, minimax: {} } },
			overridesOfModel: { openCodeGo: { 'qwen3.6-plus': { contextWindow: 100000 } }, minimax: {} },
		});

		test('Go: ключ, выбор модели, роли, параметры и правки моделей уходят к провайдеру из файла', () => {
			const state = used();
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual(
				{
					report,
					key: state.dynamicProviderApiKeys,
					visible: state.dynamicModelHidden,
					goLeft: !!state.settingsOfProvider && Object.hasOwn(state.settingsOfProvider, 'openCodeGo'),
					zenKept: state.settingsOfProvider?.openCodeZen?.apiKey,
					chat: state.modelSelectionOfFeature?.Chat,
					other: state.modelSelectionOfFeature?.['Ctrl+K'],
					role: state.modelSelectionOfRole?.reviewer,
					options: state.optionsOfModelSelection?.Chat,
					overrides: state.overridesOfModel,
				},
				{
					report: { moved: [{ legacyId: 'openCodeGo', configId: OPENCODE_GO_CONFIG_ID, movedKey: true, movedSelections: 2, movedVisibleModels: 1, movedCustomModels: 0, movedParams: [] }], filesToCreate: [] },
					key: { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' },
					visible: { [OPENCODE_GO_CONFIG_ID]: { 'qwen3.6-plus': false } },
					goLeft: false,
					zenKept: 'sk-zen-1',
					chat: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' },
					other: { providerName: 'minimax', modelName: 'MiniMax-M3' },
					role: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'kimi-k2.6' },
					options: { minimax: {}, [OPENCODE_GO_CONFIG_ID]: { 'qwen3.6-plus': { reasoningEffort: 'high' } } },
					overrides: { minimax: {}, [OPENCODE_GO_CONFIG_ID]: { 'qwen3.6-plus': { contextWindow: 100000 } } },
				},
			);
		});

		test('каждый вырезанный провайдер переезжает на свой id из набора: ключ, выбор и параметры выбора', () => {
			for (const vendor of PROVIDER_VENDORS) {
				const legacyId = vendor;
				const configId = CONFIG_ID_OF_VENDOR[vendor];
				const state: ProviderMigratableState = {
					settingsOfProvider: { [legacyId]: { apiKey: `key-of-${vendor}-1234567890`, models: [] } },
					modelSelectionOfFeature: { Chat: { providerName: legacyId, modelName: 'm1' } },
					optionsOfModelSelection: { Chat: { [legacyId]: { m1: { reasoningEffort: 'low' } } } },
				};
				migrateLegacyProviders(state);
				assert.deepStrictEqual(
					{
						vendor,
						left: !!state.settingsOfProvider && Object.hasOwn(state.settingsOfProvider, legacyId) && legacyId !== configId,
						key: state.dynamicProviderApiKeys?.[configId],
						chat: state.modelSelectionOfFeature?.Chat?.providerName,
						options: Object.keys(state.optionsOfModelSelection?.Chat ?? {}),
					},
					{ vendor, left: false, key: `key-of-${vendor}-1234567890`, chat: configId, options: [configId] },
				);
			}
		});

		test('Anthropic с тем же id: запись старой формы убирается, ключ уходит в слот файлового провайдера, выбор остаётся', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: { anthropic: { apiKey: 'sk-ant-xyz-1234567890', models: [{ modelName: 'claude-sonnet-5-5', isHidden: false }] } },
				modelSelectionOfFeature: { Chat: { providerName: 'anthropic', modelName: 'claude-sonnet-5-5' } },
			};
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual(
				{
					settingsLeft: !!state.settingsOfProvider && Object.hasOwn(state.settingsOfProvider, 'anthropic'),
					key: state.dynamicProviderApiKeys,
					visible: state.dynamicModelHidden,
					chat: state.modelSelectionOfFeature?.Chat,
					moved: report?.moved.map(m => [m.configId, m.movedKey, m.movedSelections, m.movedVisibleModels]),
				},
				{
					settingsLeft: false,
					key: { anthropic: 'sk-ant-xyz-1234567890' },
					visible: { anthropic: { 'claude-sonnet-5-5': false } },
					chat: { providerName: 'anthropic', modelName: 'claude-sonnet-5-5' },
					moved: [['anthropic', true, 0, 1]],
				},
			);
		});

		test('поля карточки Vertex, Azure и шлюза Bedrock уходят в параметры провайдера; умолчания и версия API Azure не переносятся, адрес шлюза получает /v1', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: {
					googleVertex: { region: 'europe-west4', project: 'my-proj', models: [] },
					microsoftAzure: { project: 'my-res', apiKey: 'azure-key-1234567890', azureApiVersion: '2025-01-01-preview', models: [] },
					awsBedrock: { endpoint: 'http://gw.local:4000', region: 'eu-west-1', apiKey: 'bk-1234567890', models: [] },
				},
			};
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual(
				{
					params: state.dynamicProviderParams,
					keys: state.dynamicProviderApiKeys,
					moved: report?.moved.map(m => [m.configId, m.movedParams]),
				},
				{
					params: {
						'google-vertex': { region: 'europe-west4', project: 'my-proj' },
						'azure-openai': { resource: 'my-res' },
						'aws-bedrock': { endpoint: 'http://gw.local:4000/v1' },
					},
					keys: { 'azure-openai': 'azure-key-1234567890', 'aws-bedrock': 'bk-1234567890' },
					moved: [['google-vertex', ['region', 'project']], ['aws-bedrock', ['endpoint']], ['azure-openai', ['resource']]],
				},
			);
		});

		test('Vertex со стандартным регионом и без проекта — переносить нечего', () => {
			const state: ProviderMigratableState = { settingsOfProvider: { googleVertex: { region: 'us-west2', project: '', models: [] } } };
			assert.deepStrictEqual([migrateLegacyProviders(state), state.dynamicProviderParams], [undefined, undefined]);
		});

		test('«Совместимо с OpenAI API»: адрес и заголовки в параметры, файл провайдера отправляется на создание', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: { openAICompatible: { endpoint: 'https://my.site/v1', apiKey: 'sk-compat-1234567890', headersJSON: '{"X-Team":"a"}', models: [{ modelName: 'llama-70b', isHidden: false, type: 'custom' }] } },
				modelSelectionOfFeature: { Chat: { providerName: 'openAICompatible', modelName: 'llama-70b' } },
			};
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual(
				{
					params: state.dynamicProviderParams,
					key: state.dynamicProviderApiKeys,
					custom: state.dynamicCustomModels,
					chat: state.modelSelectionOfFeature?.Chat,
					files: report?.filesToCreate,
				},
				{
					params: { 'openai-compatible': { endpoint: 'https://my.site/v1', headersJSON: '{"X-Team":"a"}' } },
					key: { 'openai-compatible': 'sk-compat-1234567890' },
					custom: { 'openai-compatible': ['llama-70b'] },
					chat: { providerName: 'openai-compatible', modelName: 'llama-70b' },
					files: ['openai-compatible'],
				},
			);
		});

		test('пустые заголовки «{}» у «Совместимо с OpenAI API» не переносятся, файл без адреса не создаётся', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: { openAICompatible: { endpoint: '', apiKey: '', headersJSON: '{}', models: [] } },
			};
			assert.deepStrictEqual([migrateLegacyProviders(state), state.dynamicProviderParams], [undefined, undefined]);
		});

		test('добавленные человеком модели переезжают списком своих, скрытая вручную остаётся скрытой', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: { openAI: { apiKey: 'sk-openai-1234567890', models: [
					{ modelName: 'ft:gpt-4o:org::abc', isHidden: false, type: 'custom' },
					{ modelName: 'gpt-old', isHidden: true, type: 'custom' },
					{ modelName: 'gpt-6-luna', isHidden: false, type: 'autodetected' },
					{ modelName: 'gpt-6-sol', isHidden: true, type: 'autodetected' },
				] } },
			};
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual(
				{ custom: state.dynamicCustomModels, hidden: state.dynamicModelHidden, counts: report?.moved.map(m => [m.movedVisibleModels, m.movedCustomModels]) },
				{ custom: { openai: ['ft:gpt-4o:org::abc', 'gpt-old'] }, hidden: { openai: { 'gpt-old': true, 'gpt-6-luna': false } }, counts: [[1, 2]] },
			);
		});

		test('повторный перенос ничего не делает', () => {
			const state = used();
			migrateLegacyProviders(state);
			const snapshot = JSON.stringify(state);
			assert.deepStrictEqual([migrateLegacyProviders(state), JSON.stringify(state) === snapshot], [undefined, true]);
		});

		test('ключ, уже введённый у провайдера из файла, не затирается', () => {
			const state = used();
			state.dynamicProviderApiKeys = { [OPENCODE_GO_CONFIG_ID]: 'sk-already-typed' };
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual([report?.moved[0].movedKey, state.dynamicProviderApiKeys[OPENCODE_GO_CONFIG_ID]], [false, 'sk-already-typed']);
		});

		test('параметр, уже введённый у провайдера из файла, не затирается', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: { googleVertex: { region: 'europe-west4', project: 'old', models: [] } },
				dynamicProviderParams: { 'google-vertex': { project: 'typed-already' } },
			};
			migrateLegacyProviders(state);
			assert.deepStrictEqual(state.dynamicProviderParams, { 'google-vertex': { project: 'typed-already', region: 'europe-west4' } });
		});

		test('пустые встроенные провайдеры (стартовые значения) переносить нечего и говорить об этом не нужно', () => {
			const fresh: ProviderMigratableState = {
				settingsOfProvider: Object.fromEntries(REMOVED_BUILTIN_IDS.map(id => [id, { apiKey: '', models: [{ modelName: 'm', isHidden: true }] }])),
				modelSelectionOfFeature: { Chat: null },
			};
			const report = migrateLegacyProviders(fresh);
			assert.deepStrictEqual(
				{ report, mention: providerMigrationWorthMentioning(report), left: Object.keys(fresh.settingsOfProvider ?? {}) },
				{ report: undefined, mention: false, left: [] },
			);
		});

		test('состояние без вырезанных провайдеров (свежий профиль) отчёта не даёт', () => {
			assert.strictEqual(migrateLegacyProviders({ settingsOfProvider: { openCodeZen: { apiKey: '' } }, modelSelectionOfFeature: {} }), undefined);
		});

		test('выбор, оставшийся на вырезанном провайдере без ключа, тоже переезжает: провайдер появится, когда файл будет прочитан', () => {
			const state: ProviderMigratableState = {
				settingsOfProvider: { openCodeGo: { apiKey: '', models: [] } },
				modelSelectionOfFeature: { Chat: { providerName: 'openCodeGo', modelName: 'minimax-m3' } },
			};
			const report = migrateLegacyProviders(state);
			assert.deepStrictEqual(
				[state.modelSelectionOfFeature?.Chat, providerMigrationWorthMentioning(report)],
				[{ providerName: OPENCODE_GO_CONFIG_ID, modelName: 'minimax-m3' }, true],
			);
		});

		test('файл «Совместимо с OpenAI API» — это определение с параметрами, без вписанных значений человека', () => {
			const file = MIGRATED_PROVIDER_FILES['openai-compatible'];
			assert.deepStrictEqual(
				{ name: file.fileName, hasParams: file.text.includes('"endpoint"') && file.text.includes('"as": "headers"'), baseURL: file.text.includes('"baseURL": "{endpoint}"'), noSecrets: !/https?:\/\/(?!my-website)/.test(file.text.replace(/\/\/[^\n]*/g, '')) },
				{ name: 'openai-compatible.jsonc', hasParams: true, baseURL: true, noSecrets: true },
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
				modelSelectionOfFeature: { Chat: { providerName: 'openCodeGo', modelName: 'qwen3.6-plus' }, 'Ctrl+K': null, Autocomplete: null, Apply: null, SCM: null },
				optionsOfModelSelection: { Chat: {}, 'Ctrl+K': {}, Autocomplete: {}, Apply: {}, SCM: {} },
			});
			const persisted = storedState(storage);
			assert.deepStrictEqual(
				{
					memory: {
						goLeft: Object.hasOwn(service.state.settingsOfProvider, 'openCodeGo'),
						key: service.state.dynamicProviderApiKeys,
						chat: service.state.modelSelectionOfFeature.Chat,
						scm: service.state.modelSelectionOfFeature.SCM,
						custom: service.state.dynamicCustomModels,
					},
					persisted: {
						goLeft: Object.hasOwn(persisted.settingsOfProvider, 'openCodeGo'),
						key: persisted.dynamicProviderApiKeys,
						chat: persisted.modelSelectionOfFeature.Chat,
						custom: persisted.dynamicCustomModels,
					},
					notice: JSON.parse(storage.get(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION)!),
				},
				{
					memory: { goLeft: false, key: { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' }, chat: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' }, scm: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' }, custom: { [OPENCODE_GO_CONFIG_ID]: ['qwen3.6-plus'] } },
					persisted: { goLeft: false, key: { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' }, chat: { providerName: OPENCODE_GO_CONFIG_ID, modelName: 'qwen3.6-plus' }, custom: { [OPENCODE_GO_CONFIG_ID]: ['qwen3.6-plus'] } },
					notice: { moved: [{ legacyId: 'openCodeGo', configId: OPENCODE_GO_CONFIG_ID, movedKey: true, movedSelections: 2, movedVisibleModels: 0, movedCustomModels: 1, movedParams: [] }], filesToCreate: [] },
				},
			);
		});

		test('у пользователя Anthropic, OpenAI и Vertex одним запуском переезжают ключи, выбор и поля; прежних записей в состоянии нет', async () => {
			const { service, storage } = await startService({
				globalSettings: {},
				settingsOfProvider: {
					anthropic: { apiKey: 'sk-ant-key-1234567890', models: [] },
					openAI: { apiKey: 'sk-openai-key-1234567890', models: [] },
					googleVertex: { region: 'europe-west4', project: 'proj-1', models: [] },
					openAICompatible: { endpoint: 'https://gw.example/v1', apiKey: '', headersJSON: '{}', models: [] },
				},
				modelSelectionOfFeature: { Chat: { providerName: 'openAI', modelName: 'gpt-6-luna' }, 'Ctrl+K': null, Autocomplete: null, Apply: null, SCM: null },
				optionsOfModelSelection: { Chat: {}, 'Ctrl+K': {}, Autocomplete: {}, Apply: {}, SCM: {} },
			});
			const persisted = storedState(storage);
			assert.deepStrictEqual(
				{
					left: ['anthropic', 'openAI', 'googleVertex', 'openAICompatible'].filter(id => Object.hasOwn(persisted.settingsOfProvider, id)),
					keys: persisted.dynamicProviderApiKeys,
					params: persisted.dynamicProviderParams,
					chat: service.state.modelSelectionOfFeature.Chat,
					files: JSON.parse(storage.get(PROVIDER_FILES_MIGRATION_KEY, StorageScope.APPLICATION)!),
					notified: JSON.parse(storage.get(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION)!).moved.map((m: { configId: string }) => m.configId),
				},
				{
					left: [],
					keys: { anthropic: 'sk-ant-key-1234567890', openai: 'sk-openai-key-1234567890' },
					params: { 'google-vertex': { region: 'europe-west4', project: 'proj-1' }, 'openai-compatible': { endpoint: 'https://gw.example/v1' } },
					chat: { providerName: 'openai', modelName: 'gpt-6-luna' },
					files: ['openai-compatible'],
					notified: ['anthropic', 'openai', 'google-vertex', 'openai-compatible'],
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
			first.storage.remove(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION);

			const second = new TestStorageService();
			store.add(second);
			second.store(VOID_SETTINGS_STORAGE_KEY, afterFirst, StorageScope.APPLICATION, StorageTarget.USER);
			store.add(new VoidSettingsService(second, encryption, metrics, new TestConfigurationService()));
			await timeout(0);
			assert.deepStrictEqual(
				[second.get(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION), JSON.parse(second.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION)!).dynamicProviderApiKeys],
				[undefined, { [OPENCODE_GO_CONFIG_ID]: 'sk-go-123' }],
			);
		});

		test('свежий профиль и пользователь без вырезанных: уведомления нет, ключей у провайдеров из файлов нет', async () => {
			const fresh = await startService(undefined);
			const empty = await startService({
				globalSettings: {},
				settingsOfProvider: { openCodeGo: { apiKey: '', models: [] }, anthropic: { apiKey: '', models: [] } },
				modelSelectionOfFeature: { Chat: null },
				optionsOfModelSelection: { Chat: {} },
			});
			assert.deepStrictEqual(
				[fresh, empty].map(({ service, storage }) => ({
					notice: storage.get(PROVIDER_MIGRATION_NOTICE_KEY, StorageScope.APPLICATION),
					files: storage.get(PROVIDER_FILES_MIGRATION_KEY, StorageScope.APPLICATION),
					keys: service.state.dynamicProviderApiKeys,
					goLeft: Object.hasOwn(service.state.settingsOfProvider, 'openCodeGo'),
					anthropicLeft: Object.hasOwn(service.state.settingsOfProvider, 'anthropic'),
				})),
				[
					{ notice: undefined, files: undefined, keys: {}, goLeft: false, anthropicLeft: false },
					{ notice: undefined, files: undefined, keys: {}, goLeft: false, anthropicLeft: false },
				],
			);
		});

		test('значение параметра провайдера из карточки сохраняется и возвращается к умолчанию пустой строкой', async () => {
			const { service, storage } = await startService(undefined);
			await service.setDynamicProviderParam('google-vertex', 'project', 'my-proj');
			const afterSet = storedState(storage).dynamicProviderParams;
			await service.setDynamicProviderParam('google-vertex', 'project', '  ');
			assert.deepStrictEqual([afterSet, storedState(storage).dynamicProviderParams], [{ 'google-vertex': { project: 'my-proj' } }, {}]);
		});

		test('свою модель файлового провайдера можно добавить и удалить, а встроенного — прежним путём', async () => {
			const { service, storage } = await startService(undefined);
			service.addModel('openai', 'ft:gpt-4o:org::abc');
			service.addModel('openai', 'ft:gpt-4o:org::abc');
			await timeout(0);
			const afterAdd = storedState(storage);
			const removed = service.deleteModel('openai', 'ft:gpt-4o:org::abc');
			const missing = service.deleteModel('openai', 'нет такой');
			await timeout(0);
			assert.deepStrictEqual(
				{
					custom: afterAdd.dynamicCustomModels,
					shown: afterAdd.dynamicModelHidden,
					removed, missing,
					customAfter: storedState(storage).dynamicCustomModels,
				},
				{ custom: { openai: ['ft:gpt-4o:org::abc'] }, shown: { openai: { 'ft:gpt-4o:org::abc': false } }, removed: true, missing: false, customAfter: {} },
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
