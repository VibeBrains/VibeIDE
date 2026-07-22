/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	apiKeyEnvVarOfProvider,
	envCapableProviderNames,
	resolveApiKeyWithEnv,
	withEnvApiKey,
	SettingsOfProvider,
} from '../../common/vibeideSettingsTypes.js';
import { defaultProviderSettings } from '../../common/modelCapabilities.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Provider API key from OS environment', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveApiKeyWithEnv', () => {
		test('UI key wins over the environment', () => {
			assert.strictEqual(resolveApiKeyWithEnv('sk-ui', 'anthropic', { ANTHROPIC_API_KEY: 'sk-env' }), 'sk-ui');
		});

		test('falls back to the env key when the UI key is empty or whitespace', () => {
			const env = { ANTHROPIC_API_KEY: 'sk-env' };
			assert.deepStrictEqual(
				[resolveApiKeyWithEnv('', 'anthropic', env), resolveApiKeyWithEnv('   ', 'anthropic', env), resolveApiKeyWithEnv(undefined, 'anthropic', env)],
				['sk-env', 'sk-env', 'sk-env'],
			);
		});

		test('trims the env value — a trailing newline would break the HTTP header', () => {
			assert.strictEqual(resolveApiKeyWithEnv('', 'openAI', { OPENAI_API_KEY: ' sk-env\n' }), 'sk-env');
		});

		test('returns empty when neither source has a key, and ignores unrelated vars', () => {
			assert.strictEqual(resolveApiKeyWithEnv('', 'anthropic', { SOMETHING_ELSE: 'x' }), '');
		});

		test('providers without an env convention keep the configured value', () => {
			// openCodeZen is deliberately absent from apiKeyEnvVarOfProvider.
			assert.strictEqual(resolveApiKeyWithEnv('', 'openCodeZen', { OPENCODEZEN_API_KEY: 'sk-env' }), '');
		});
	});

	suite('withEnvApiKey', () => {
		const baseSettings = () => ({
			anthropic: { apiKey: '' },
			openAI: { apiKey: 'sk-ui' },
		} as unknown as SettingsOfProvider);

		test('substitutes the env key only for the requested provider', () => {
			const result = withEnvApiKey(baseSettings(), 'anthropic', { ANTHROPIC_API_KEY: 'sk-env', OPENAI_API_KEY: 'sk-other' });
			assert.deepStrictEqual(
				{ anthropic: result.anthropic.apiKey, openAI: result.openAI.apiKey },
				{ anthropic: 'sk-env', openAI: 'sk-ui' },
			);
		});

		test('returns the same object when there is nothing to substitute', () => {
			const settings = baseSettings();
			assert.strictEqual(withEnvApiKey(settings, 'anthropic', {}), settings);
			assert.strictEqual(withEnvApiKey(settings, 'openAI', { OPENAI_API_KEY: 'sk-env' }), settings);
		});
	});

	suite('apiKeyEnvVarOfProvider', () => {
		test('every listed provider exists and has apiKey as its only required setting', () => {
			// The env key must be enough on its own: _didFillInProviderSettings requires every field of
			// a provider to be filled, so a provider needing an endpoint/region could never be unblocked
			// by an env key alone. This guards against adding such a provider to the map by mistake.
			const offenders = envCapableProviderNames.filter(providerName => {
				const fields = defaultProviderSettings[providerName] as Record<string, string> | undefined;
				if (!fields) { return true; }
				return Object.keys(fields).some(field => field !== 'apiKey' && field !== 'publicCatalog');
			});
			assert.deepStrictEqual(offenders, []);
		});

		test('env var names are unique', () => {
			const names = Object.values(apiKeyEnvVarOfProvider);
			assert.strictEqual(new Set(names).size, names.length);
		});
	});
});
