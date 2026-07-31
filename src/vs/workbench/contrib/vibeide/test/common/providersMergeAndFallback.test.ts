/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { API_PROTOCOL_TO_SDK_NPM, sdkNpmOfFileProtocol } from '../../common/modelCapabilities.js';
import { mergeProvidersLists, VibeProviderEntry } from '../../common/vibeProvidersFile.js';
import { autoFallbackProviderIds, autoModelFallbackProviderOrder, isBuiltinProviderId, isFeatureNameDisabled, SettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { isLocalProvider } from '../../common/isLocalProvider.js';
import { VibeideSettingsState } from '../../common/vibeideSettingsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Config providers — merged rights (global+workspace, auto-fallback)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('mergeProvidersLists (global ← workspace)', () => {
		const g = (e: Partial<VibeProviderEntry> & { id: string }) => e as VibeProviderEntry;

		test('workspace wins field-level on the same id, global position kept', () => {
			const merged = mergeProvidersLists(
				[g({ id: 'corp', baseURL: 'https://global.corp/v1', order: 10, name: 'Corp (global)' }), g({ id: 'other', baseURL: 'https://other/v1' })],
				[g({ id: 'corp', baseURL: 'https://ws.corp/v1' })],
			);
			assert.deepStrictEqual(
				merged.map(e => ({ id: e.id, baseURL: e.baseURL, order: e.order, name: e.name })),
				[
					{ id: 'corp', baseURL: 'https://ws.corp/v1', order: 10, name: 'Corp (global)' }, // baseURL overridden, rest inherited
					{ id: 'other', baseURL: 'https://other/v1', order: undefined, name: undefined },
				],
			);
		});

		test('workspace-only entries are appended after global ones', () => {
			const merged = mergeProvidersLists([g({ id: 'a' })], [g({ id: 'b' }), g({ id: 'c' })]);
			assert.deepStrictEqual(merged.map(e => e.id), ['a', 'b', 'c']);
		});

		test('models.static merges by model id (workspace patches, new ids appended)', () => {
			const merged = mergeProvidersLists(
				[g({ id: 'p', models: { fetch: false, static: [{ id: 'm1', name: 'Global M1', contextWindow: 1000 }, { id: 'm2' }] } })],
				[g({ id: 'p', models: { static: [{ id: 'm1', name: 'WS M1' }, { id: 'm3' }] } })],
			);
			const models = merged[0].models?.static ?? [];
			assert.deepStrictEqual(
				models.map(m => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
				[
					{ id: 'm1', name: 'WS M1', contextWindow: 1000 }, // patched name, inherited caps
					{ id: 'm2', name: undefined, contextWindow: undefined },
					{ id: 'm3', name: undefined, contextWindow: undefined },
				],
			);
		});

		test('a surviving extends directive is preserved for the later resolution pass', () => {
			const merged = mergeProvidersLists(
				[g({ id: 'fav', extends: 'openRouter', name: 'Fav (global)' })],
				[g({ id: 'fav', order: 5 })],
			);
			assert.deepStrictEqual(
				{ extends: merged[0].extends, order: merged[0].order, name: merged[0].name },
				{ extends: 'openRouter', order: 5, name: 'Fav (global)' },
			);
		});

		test('either side may be empty', () => {
			assert.deepStrictEqual(mergeProvidersLists([], [g({ id: 'x' })]).map(e => e.id), ['x']);
			assert.deepStrictEqual(mergeProvidersLists([g({ id: 'y' })], []).map(e => e.id), ['y']);
		});
	});

	suite('autoFallbackProviderIds (merged auto-selection order)', () => {
		test('config providers come first (their insertion order), then the built-in order', () => {
			// Insertion order mirrors _validatedModelState: built-ins from the defaults literal, then
			// config seeds appended in their sorted order.
			const settings = {
				anthropic: { apiKey: 'x', _didFillInProviderSettings: true, models: [] },
				'corp-proxy': { apiKey: '', endpoint: 'https://corp/v1', _didFillInProviderSettings: true, models: [] },
				'zai': { apiKey: '', endpoint: 'https://zai/v1', _didFillInProviderSettings: true, models: [] },
			} as unknown as SettingsOfProvider;
			const order = autoFallbackProviderIds(settings);
			assert.deepStrictEqual(order.slice(0, 2), ['corp-proxy', 'zai']);
			assert.deepStrictEqual(order.slice(2), [...autoModelFallbackProviderOrder]);
		});

		test('no config providers → exactly the built-in order', () => {
			const settings = { anthropic: { apiKey: '', _didFillInProviderSettings: false, models: [] } } as unknown as SettingsOfProvider;
			assert.deepStrictEqual(autoFallbackProviderIds(settings), [...autoModelFallbackProviderOrder]);
		});
	});

	suite('isBuiltinProviderId', () => {
		test('narrows built-ins and rejects config ids', () => {
			assert.deepStrictEqual(
				['anthropic', 'openAI', 'zai', 'corp-proxy', ''].map(isBuiltinProviderId),
				[true, true, false, false, false],
			);
		});
	});

	suite('isLocalProvider (merged set)', () => {
		const settings = {
			ollama: { endpoint: 'http://127.0.0.1:11434', models: [] },
			'corp-local': { endpoint: 'http://localhost:8080/v1', models: [] },
			'corp-cloud': { endpoint: 'https://llm.corp.example/v1', models: [] },
			'corp-broken': { endpoint: 'not a url', models: [] },
		} as unknown as SettingsOfProvider;

		test('explicit locals, localhost config provider, cloud config provider, broken endpoint', () => {
			assert.deepStrictEqual(
				['ollama', 'corp-local', 'corp-cloud', 'corp-broken', 'anthropic'].map(id => isLocalProvider(id, settings)),
				[true, true, false, false, false],
			);
		});
	});

	suite('sdkNpmOfFileProtocol (file protocol → SDK wire format)', () => {
		test('maps the three declared values; file "openai" means openai-COMPATIBLE, not native', () => {
			assert.deepStrictEqual(
				['openai', 'anthropic', 'gemini', 'nonsense', undefined].map(v => sdkNpmOfFileProtocol(v)),
				[
					API_PROTOCOL_TO_SDK_NPM['openai-compat'],
					API_PROTOCOL_TO_SDK_NPM['anthropic'],
					API_PROTOCOL_TO_SDK_NPM['google'],
					undefined, // unknown → caller falls through to the models.dev catalog
					undefined,
				],
			);
		});
	});

	suite('isFeatureNameDisabled sees config providers', () => {
		const stateWith = (settingsOfProvider: object): VibeideSettingsState => ({
			settingsOfProvider,
			modelSelectionOfFeature: { 'Chat': null, 'Ctrl+K': null, 'Autocomplete': null, 'Apply': null, 'SCM': null },
			optionsOfModelSelection: { 'Chat': {}, 'Ctrl+K': {}, 'Autocomplete': {}, 'Apply': {}, 'SCM': {} },
			overridesOfModel: {},
			globalSettings: {},
			mcpUserStateOfName: {},
			_modelOptions: [],
		} as unknown as VibeideSettingsState);

		test('a filled-in config provider yields addModel, not addProvider', () => {
			const state = stateWith({
				anthropic: { apiKey: '', _didFillInProviderSettings: false, models: [] },
				'corp-proxy': { apiKey: '', endpoint: 'https://corp/v1', _didFillInProviderSettings: true, models: [] },
			});
			assert.strictEqual(isFeatureNameDisabled('Chat', state), 'addModel');
		});

		test('a hidden config-provider model yields needToEnableModel', () => {
			const state = stateWith({
				anthropic: { apiKey: '', _didFillInProviderSettings: false, models: [] },
				'corp-proxy': { apiKey: '', _didFillInProviderSettings: false, models: [{ modelName: 'm', type: 'autodetected', isHidden: true }] },
			});
			assert.strictEqual(isFeatureNameDisabled('Chat', state), 'needToEnableModel');
		});

		test('nothing configured anywhere yields addProvider', () => {
			const state = stateWith({
				anthropic: { apiKey: '', _didFillInProviderSettings: false, models: [] },
			});
			assert.strictEqual(isFeatureNameDisabled('Chat', state), 'addProvider');
		});
	});
});
