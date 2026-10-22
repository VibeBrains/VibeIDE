/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { builtinProviderIdOf, isBuiltinProviderId, providerNames } from '../../common/vibeideSettingsTypes.js';

suite('Built-in provider id matching', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('seed-set spelling resolves to the built-in it should patch', () => {
		// The shared seed set (VibeBrains repo, installed into `.vibe/` by both products) writes ids
		// lowercase-with-dashes because VibeIDEA reads them that way. Copying such a file into
		// `providers.json` must patch the built-in, not define a twin beside it.
		assert.deepStrictEqual(
			['openrouter', 'opencode-zen', 'OpenRouter', 'open_router', 'deep-seek', 'lm-studio'].map(builtinProviderIdOf),
			['openRouter', 'openCodeZen', 'openRouter', 'openRouter', 'deepseek', 'lmStudio']);
	});

	// Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Pollinations, Vertex, Azure, Bedrock и «Совместимо с OpenAI API» вышли из встроенных:
	// их файлы набора ОПРЕДЕЛЯЮТ провайдеров, а не патчат встроенных. Совпадет id со встроенным снова — файл станет патчем
	// несуществующего, и провайдер пропадёт из списка
	test('removed built-ins are not built in: their seed files define them', () => {
		assert.deepStrictEqual(
			['openai', 'openAI', 'anthropic', 'google-gemini', 'gemini', 'xai', 'google-vertex', 'azure-openai', 'aws-bedrock', 'openai-compatible', 'groq', 'mistral', 'pollinations']
				.map(id => [builtinProviderIdOf(id), isBuiltinProviderId(id)]),
			Array.from({ length: 13 }, () => [undefined, false]));
	});

	// OpenCode Go вышел из встроенных: файл набора `opencode-go.jsonc` теперь ОПРЕДЕЛЯЕТ провайдера, а не патчит встроенного.
	// Если id снова совпадёт со встроенным, файл превратится в патч несуществующего и провайдер пропадёт из списка
	test('OpenCode Go is not built in: the seed file defines it', () => {
		assert.deepStrictEqual(
			[builtinProviderIdOf('opencode-go'), builtinProviderIdOf('openCodeGo'), isBuiltinProviderId('opencode-go')],
			[undefined, undefined, false]);
	});

	test('an unknown id still defines a new provider', () => {
		assert.deepStrictEqual(
			['my-proxy', 'kimi', 'zai', ''].map(id => isBuiltinProviderId(id)),
			[false, false, false, false]);
	});

	/**
	 * The whole scheme rests on this: if two built-ins ever normalised to the same string, one of
	 * them would silently swallow the other's config. A new built-in id must not collide.
	 */
	test('no two built-in ids collide once normalised', () => {
		const normalised = providerNames.map(name => name.toLowerCase().replace(/[-_]/g, ''));
		assert.strictEqual(new Set(normalised).size, providerNames.length);
	});
});
