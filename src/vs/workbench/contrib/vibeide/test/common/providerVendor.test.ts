/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Anthropic, OpenAI, Gemini, xAI, Mistral, Groq и прочие вышли из встроенных, а знание об их моделях осталось: профили Claude,
// GPT, Gemini нужны провайдерам из файлов. Здесь стерегутся: вендор по id и адресу, таблицы моделей файловых провайдеров,
// провод вендора, комплектные файлы набора, образец для «Добавить провайдера» и подстановка параметров в настоящие файлы набора.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { BUNDLED_PROVIDER_IDS, bundledProviderLayer, bundledProviderPath } from '../../common/bundledProviders.js';
import { builtinWireSdkNpm, getModelCapabilities, isFreeModel, providerVendor, setExternalProviders } from '../../common/modelCapabilities.js';
import { providerSupportsFIM } from '../../common/providerFim.js';
import { providerFromTemplate, PROVIDER_TEMPLATE_PATH, providerIdFromName, keyEnvNameOf } from '../../common/providerTemplate.js';
import { canonicalProviderId, CONFIG_ID_OF_VENDOR, PROVIDER_VENDORS, providerVendorKey, vendorOfBaseURL, vendorOfProvider, vendorOfProviderId } from '../../common/providerVendor.js';
import { vibeDefaultContent } from '../../common/vibeDefaults.js';
import { applyProviderParams } from '../../common/vibeProviderParams.js';
import { parseProvidersFile, usesGoogleAdc } from '../../common/vibeProvidersFile.js';
import { isNativeVisionProvider, isProviderConnected, isVisionAggregatorProvider } from '../../common/visionProviders.js';

suite('Вендор провайдера — по id и по адресу', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('id вендора читается в любом написании: прежнем встроенном, файла набора, с другим регистром и разделителями', () => {
		const expected: Record<string, string> = {
			anthropic: 'anthropic', Anthropic: 'anthropic',
			openAI: 'openAI', openai: 'openAI', 'open-ai': 'openAI', OPENAI: 'openAI',
			gemini: 'gemini', 'google-gemini': 'gemini', googleGemini: 'gemini',
			xAI: 'xAI', xai: 'xAI',
			mistral: 'mistral', groq: 'groq', pollinations: 'pollinations',
			googleVertex: 'googleVertex', 'google-vertex': 'googleVertex',
			microsoftAzure: 'microsoftAzure', 'azure-openai': 'microsoftAzure',
			awsBedrock: 'awsBedrock', 'aws-bedrock': 'awsBedrock',
			openAICompatible: 'openAICompatible', 'openai-compatible': 'openAICompatible',
		};
		assert.deepStrictEqual(
			Object.fromEntries(Object.keys(expected).map(id => [id, vendorOfProviderId(id)])),
			expected,
		);
	});

	test('чужие id вендором не становятся', () => {
		assert.deepStrictEqual(
			['kimi', 'zai', 'minimax', 'openRouter', 'opencode-go', 'my-proxy', ''].map(vendorOfProviderId),
			[undefined, undefined, undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('адрес вендора узнаёт его провайдера под любым id; чужой адрес и не-адрес — нет', () => {
		assert.deepStrictEqual(
			[
				'https://api.anthropic.com/v1', 'https://API.OpenAI.com/v1', 'https://generativelanguage.googleapis.com/v1beta',
				'https://api.x.ai/v1', 'https://api.mistral.ai/v1', 'https://api.groq.com/openai/v1', 'https://gen.pollinations.ai/v1',
				'https://api.anthropic.com.evil.example/v1', 'http://localhost:4000', 'не адрес', '',
			].map(vendorOfBaseURL),
			['anthropic', 'openAI', 'gemini', 'xAI', 'mistral', 'groq', 'pollinations', undefined, undefined, undefined, undefined],
		);
	});

	test('сначала решает id, затем адрес', () => {
		assert.deepStrictEqual(
			[vendorOfProvider('my-claude', 'https://api.anthropic.com/v1'), vendorOfProvider('openai', 'https://my-proxy.example/v1'), vendorOfProvider('my-proxy', 'https://my-proxy.example/v1')],
			['anthropic', 'openAI', undefined],
		);
	});

	test('у каждого вендора есть id файла набора, все они различны и узнаются обратно', () => {
		const ids = PROVIDER_VENDORS.map(vendor => CONFIG_ID_OF_VENDOR[vendor]);
		assert.deepStrictEqual(
			{ unique: new Set(ids).size === ids.length, back: ids.map(id => vendorOfProviderId(id)) },
			{ unique: true, back: [...PROVIDER_VENDORS] },
		);
	});

	test('прежнее написание встроенного приводится к id файла; всё остальное проходит как есть', () => {
		assert.deepStrictEqual(
			['openAI', 'gemini', 'xAI', 'googleVertex', 'microsoftAzure', 'awsBedrock', 'openAICompatible', 'anthropic', 'groq', 'openai', 'kimi', 'minimax'].map(canonicalProviderId),
			['openai', 'google-gemini', 'xai', 'google-vertex', 'azure-openai', 'aws-bedrock', 'openai-compatible', 'anthropic', 'groq', 'openai', 'kimi', 'minimax'],
		);
	});

	test('строчный ключ вендора для эвристик: google-gemini и gemini — одно, чужой id остаётся собой', () => {
		assert.deepStrictEqual(
			['openAI', 'openai', 'google-gemini', 'gemini', 'xai', 'Kimi', 'openai-compatible'].map(providerVendorKey),
			['openai', 'openai', 'gemini', 'gemini', 'xai', 'kimi', 'openaicompatible'],
		);
	});
});

suite('Таблицы моделей вендоров у файловых провайдеров', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => setExternalProviders([]));

	test('до загрузки реестра провайдер узнаётся по id: Claude, GPT, Gemini и Grok распознаны, а не «неизвестная модель»', () => {
		const recognised = (providerId: string, model: string) => !getModelCapabilities(providerId, model, undefined).isUnrecognizedModel;
		assert.deepStrictEqual(
			[
				recognised('anthropic', 'claude-opus-5-5'),
				recognised('openai', 'gpt-6-luna'),
				recognised('google-gemini', 'gemini-3.8-flash'),
				recognised('xai', 'grok-4.7'),
				recognised('openAI', 'gpt-6-luna'),
			],
			[true, true, true, true, true],
		);
	});

	test('профиль Claude на месте: контекст, цена кэша и рассуждение уровнями у Opus 5.5', () => {
		const caps = getModelCapabilities('anthropic', 'claude-opus-5-5', undefined);
		assert.deepStrictEqual(
			{ context: caps.contextWindow, cacheRead: caps.cost?.cache_read, reasoning: !!caps.reasoningCapabilities && caps.reasoningCapabilities.supportsReasoning },
			{ context: 1_000_000, cacheRead: 0.2, reasoning: true },
		);
	});

	test('Mistral: Codestral принимает автодополнение, профиль вендора действует и под id файла', () => {
		const caps = getModelCapabilities('mistral', 'codestral-latest', undefined);
		assert.strictEqual(caps.supportsFIM, true);
	});

	test('зарегистрированный провайдер с вендором берёт таблицу вендора и допускает свои записи model поверх неё', () => {
		setExternalProviders([{
			id: 'my-claude', source: 'file', vendor: 'anthropic',
			modelCapOverrides: { 'claude-opus-5-5': { contextWindow: 123_456 } },
		}]);
		const own = getModelCapabilities('my-claude', 'claude-opus-5-5', undefined);
		const other = getModelCapabilities('my-claude', 'claude-sonnet-5-5', undefined);
		assert.deepStrictEqual(
			{ own: own.contextWindow, ownCost: own.cost?.output, other: other.contextWindow, otherRecognised: !other.isUnrecognizedModel },
			{ own: 123_456, ownCost: 20, other: 1_000_000, otherRecognised: true },
		);
	});

	test('вендорская таблица не узнала модель — её дораспознаёт общий разбор, и инструменты включены, а не выключены', () => {
		setExternalProviders([{ id: 'mistral', source: 'file', vendor: 'mistral' }]);
		const caps = getModelCapabilities('mistral', 'llama-3.3-70b-versatile', undefined);
		assert.strictEqual(caps.specialToolFormat, 'openai-style');
	});

	test('провайдер без вендора остаётся на общей OpenAI-совместимой таблице', () => {
		setExternalProviders([{ id: 'kimi', source: 'file' }]);
		assert.strictEqual(providerVendor('kimi'), undefined);
		assert.strictEqual(getModelCapabilities('kimi', 'kimi-k2.7-code', undefined).specialToolFormat, 'openai-style');
	});

	test('вендор провайдера: из реестра (id и адрес), а без реестра — по одному id', () => {
		setExternalProviders([{ id: 'my-claude', source: 'file', vendor: 'anthropic' }]);
		assert.deepStrictEqual(
			[providerVendor('my-claude'), providerVendor('openai'), providerVendor('openAI'), providerVendor('kimi')],
			['anthropic', 'openAI', 'openAI', undefined],
		);
	});

	test('провод: Anthropic по Messages, Gemini нативным Google, OpenAI нативным SDK или Responses, локальные — совместимым; остальные без своего', () => {
		assert.deepStrictEqual(
			[
				builtinWireSdkNpm('anthropic', 'anthropic', undefined),
				builtinWireSdkNpm('google-gemini', 'gemini', undefined),
				builtinWireSdkNpm('openai', 'openai', undefined),
				builtinWireSdkNpm('openai', 'openai', 'openai-responses'),
				builtinWireSdkNpm('openai', 'openai-responses', undefined),
				builtinWireSdkNpm('ollama', undefined, undefined),
				builtinWireSdkNpm('kimi', 'openai', undefined),
				builtinWireSdkNpm('groq', 'openai', undefined),
			],
			[
				'@ai-sdk/anthropic', '@ai-sdk/google', '@ai-sdk/openai', '@ai-sdk/openai#responses', '@ai-sdk/openai#responses',
				'@ai-sdk/openai-compatible', undefined, undefined,
			],
		);
	});

	test('бесплатной помечается модель Pollinations под любым написанием id и модель с суффиксом :free', () => {
		assert.deepStrictEqual(
			[isFreeModel('pollinations', 'openai'), isFreeModel('anthropic', 'claude-opus-5-5'), isFreeModel('openRouter', 'x/y:free')],
			[true, false, true],
		);
	});

	test('автодополнение без объявления у модели разрешено Mistral и «Совместимо с OpenAI API», а не Anthropic и OpenAI', () => {
		assert.deepStrictEqual(
			['mistral', 'openai-compatible', 'ollama', 'openRouter', 'liteLLM', 'anthropic', 'openai', 'groq', 'deepseek'].map(providerSupportsFIM),
			[true, true, true, true, true, false, false, false, false],
		);
	});
});

suite('Зрение: кто читает картинки сам', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Anthropic, OpenAI, Gemini и Pollinations читают картинки сами под id файла и под прежним; агрегаторы — по модели', () => {
		assert.deepStrictEqual(
			{
				native: ['anthropic', 'openai', 'openAI', 'google-gemini', 'gemini', 'pollinations', 'xai', 'groq'].map(isNativeVisionProvider),
				aggregator: ['openRouter', 'openCodeZen', 'liteLLM', 'minimax', 'openai-compatible', 'anthropic', 'kimi'].map(isVisionAggregatorProvider),
			},
			{
				native: [true, true, true, true, true, true, false, false],
				aggregator: [true, true, true, true, true, false, false],
			},
		);
	});

	test('подключён: у встроенного введён настоящий ключ, у файлового сервис подтвердил доступ (ключ мог прийти из окружения)', () => {
		const models = [{ modelName: 'm', isHidden: false }];
		assert.deepStrictEqual(
			[
				isProviderConnected('minimax', { apiKey: 'sk-real-key-123456', models }),
				isProviderConnected('minimax', { apiKey: 'short', models }),
				isProviderConnected('anthropic', { apiKey: '', _didFillInProviderSettings: true, models }),
				isProviderConnected('anthropic', { apiKey: 'sk-ant-typed-but-unverified', _didFillInProviderSettings: false, models }),
				isProviderConnected('anthropic', undefined),
			],
			[true, false, true, false, false],
		);
	});
});

suite('Комплектные файлы набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('в манифесте есть файл каждого комплектного провайдера, он разбирается, и id в нём равен имени файла', () => {
		const problems: string[] = [];
		for (const id of BUNDLED_PROVIDER_IDS) {
			const raw = vibeDefaultContent(bundledProviderPath(id));
			if (raw === undefined) { problems.push(`${id}: файла нет в манифесте`); continue; }
			const parsed = parseProvidersFile(raw);
			if (!parsed.ok) { problems.push(`${id}: не разобран (${parsed.error})`); continue; }
			if (parsed.providers.length !== 1 || parsed.providers[0].id !== id) { problems.push(`${id}: id в файле ${parsed.providers.map(p => p.id).join(',')}`); }
			if (parsed.warnings.length > 0) { problems.push(`${id}: ${parsed.warnings.join('; ')}`); }
		}
		assert.deepStrictEqual(problems, []);
	});

	test('комплектных десять, и «Совместимо с OpenAI API» среди них нет: для него образец, а не провайдер', () => {
		assert.deepStrictEqual(
			[...BUNDLED_PROVIDER_IDS],
			['anthropic', 'openai', 'google-gemini', 'xai', 'mistral', 'groq', 'google-vertex', 'azure-openai', 'aws-bedrock', 'pollinations'],
		);
	});

	test('слой даёт всех десятерых включёнными: пока человек не выключил, провайдер есть и без папки', () => {
		const layer = bundledProviderLayer();
		assert.deepStrictEqual(
			{ ids: layer.map(entry => entry.id), inactive: layer.filter(entry => entry.active === false).map(entry => entry.id) },
			{ ids: [...BUNDLED_PROVIDER_IDS], inactive: [] },
		);
	});

	test('каждый комплектный файл — вендор по своему id, чтобы профиль моделей находился', () => {
		assert.deepStrictEqual(
			BUNDLED_PROVIDER_IDS.map(id => vendorOfProviderId(id) !== undefined),
			BUNDLED_PROVIDER_IDS.map(() => true),
		);
	});

	test('Vertex: адрес собирается из региона и проекта, вход — токен Google, без проекта провайдер не настроен', () => {
		const vertex = bundledProviderLayer().find(entry => entry.id === 'google-vertex')!;
		const ready = applyProviderParams(vertex, { project: 'my-proj' });
		const unready = applyProviderParams(vertex, {});
		assert.deepStrictEqual(
			{ adc: usesGoogleAdc(vertex), baseURL: ready.entry.baseURL, missing: [ready.missing, unready.missing] },
			{
				adc: true,
				baseURL: 'https://us-west2-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-west2/endpoints/openapi',
				missing: [[], ['project']],
			},
		);
	});

	test('Azure: ресурс — часть адреса, ключ уходит заголовком api-key, версия API необязательна и без значения параметра не шлётся', () => {
		const azure = bundledProviderLayer().find(entry => entry.id === 'azure-openai')!;
		const plain = applyProviderParams(azure, { resource: 'my-res' });
		const versioned = applyProviderParams(azure, { resource: 'my-res', apiVersion: 'preview' });
		assert.deepStrictEqual(
			{
				baseURL: plain.entry.baseURL,
				auth: plain.entry.auth,
				plainQuery: plain.entry.query,
				versionedQuery: versioned.entry.query,
				missing: applyProviderParams(azure, {}).missing,
			},
			{
				baseURL: 'https://my-res.openai.azure.com/openai/v1',
				auth: { type: 'header', name: 'api-key' },
				plainQuery: {},
				versionedQuery: { 'api-version': 'preview' },
				missing: ['resource'],
			},
		);
	});

	test('Bedrock: адрес шлюза по умолчанию — LiteLLM на этой машине, свой адрес перекрывает его', () => {
		const bedrock = bundledProviderLayer().find(entry => entry.id === 'aws-bedrock')!;
		assert.deepStrictEqual(
			[applyProviderParams(bedrock, {}).entry.baseURL, applyProviderParams(bedrock, { endpoint: 'https://gw.corp/v1' }).entry.baseURL, applyProviderParams(bedrock, {}).missing],
			['http://localhost:4000/v1', 'https://gw.corp/v1', []],
		);
	});

	test('Gemini включён, ключ идёт родным заголовком, а не параметром адреса', () => {
		const gemini = bundledProviderLayer().find(entry => entry.id === 'google-gemini')!;
		assert.deepStrictEqual(
			{ active: gemini.active, protocol: gemini.protocol, auth: gemini.auth },
			{ active: true, protocol: 'gemini', auth: undefined },
		);
	});
});

suite('Образец для «Добавить провайдера»', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('id из имени: латиница строчными, остальное — дефисами, края срезаются', () => {
		assert.deepStrictEqual(
			['Мой Прокси', 'My Proxy', '  corp_llm.v2  ', 'ООО «Рога»', 'a--b', ''].map(providerIdFromName),
			['', 'my-proxy', 'corp_llm.v2', '', 'a-b', ''],
		);
	});

	test('имя переменной ключа строится из id', () => {
		assert.deepStrictEqual(['my-proxy', 'corp.llm', 'x'].map(keyEnvNameOf), ['MY_PROXY_API_KEY', 'CORP_LLM_API_KEY', 'X_API_KEY']);
	});

	test('копия образца: id и имя подставлены, провайдер включён, переменная ключа своя, файл читается форматом', () => {
		const result = providerFromTemplate(vibeDefaultContent(PROVIDER_TEMPLATE_PATH), 'My Proxy');
		assert.ok(result.ok);
		const { provider } = result;
		const parsed = parseProvidersFile(provider.text);
		const entry = parsed.providers[0];
		assert.deepStrictEqual(
			{
				fileName: provider.fileName,
				ok: parsed.ok,
				warnings: parsed.warnings,
				id: entry.id, name: entry.name, active: entry.active, apiKeyEnv: entry.apiKeyEnv,
				baseURL: entry.baseURL,
				leftover: ['my-provider', 'MY_PROVIDER_API_KEY', 'Мой провайдер'].filter(sample => provider.text.includes(sample)),
				header: provider.text.split('\n')[0],
			},
			{
				fileName: 'my-proxy.jsonc',
				ok: true, warnings: [],
				id: 'my-proxy', name: 'My Proxy', active: true, apiKeyEnv: 'MY_PROXY_API_KEY',
				baseURL: 'https://api.example.com/v1',
				leftover: [],
				header: '// My Proxy — свой провайдер, созданный из образца набора.',
			},
		);
	});

	test('имя, из которого нельзя собрать id, и повреждённый образец отклоняются с причиной', () => {
		assert.deepStrictEqual(
			[
				providerFromTemplate(vibeDefaultContent(PROVIDER_TEMPLATE_PATH), '   '),
				providerFromTemplate(vibeDefaultContent(PROVIDER_TEMPLATE_PATH), 'Мой'),
				providerFromTemplate(undefined, 'x'),
				providerFromTemplate('{"providers": []}', 'x'),
			],
			[
				{ ok: false, reason: 'empty-name' },
				{ ok: false, reason: 'empty-name' },
				{ ok: false, reason: 'template-unreadable' },
				{ ok: false, reason: 'template-unreadable' },
			],
		);
	});
});
