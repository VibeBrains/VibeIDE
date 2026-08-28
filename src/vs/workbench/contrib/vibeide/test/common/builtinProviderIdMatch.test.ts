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
			['openai', 'openrouter', 'opencode-zen', 'opencode-go', 'OpenAI', 'open_router'].map(builtinProviderIdOf),
			['openAI', 'openRouter', 'openCodeZen', 'openCodeGo', 'openAI', 'openRouter']);
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
