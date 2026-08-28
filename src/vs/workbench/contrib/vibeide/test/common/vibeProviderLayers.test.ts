/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Layering of provider sources (decision of 2026-08-28): the seeded `.vibe/providers/` catalogue is
 * a live registry in both products, and it must rank BELOW the user's own `providers.json`.
 *
 * Weakest → strongest:
 *   `~/.vibe/providers/*` → `<ws>/.vibe/providers/*` → `~/.vibe/providers.json` → `<ws>/.vibe/providers.json`
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isProviderCatalogueFile, mergeProviderLayers, VibeProviderEntry } from '../../common/vibeProvidersFile.js';

suite('Provider layers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const entry = (e: VibeProviderEntry): VibeProviderEntry => e;

	test('a later catalogue file patches an earlier one field by field', () => {
		// Two files of the same directory declaring one id: alphabetical order decides, and the
		// later one overrides only the fields it names.
		const merged = mergeProviderLayers([
			[entry({ id: 'zai', name: 'Z.ai', baseURL: 'https://old.example/v1', order: 10 })],
			[entry({ id: 'zai', baseURL: 'https://new.example/v1' })],
		]);
		assert.deepStrictEqual(merged, [{ id: 'zai', name: 'Z.ai', baseURL: 'https://new.example/v1', order: 10 }]);
	});

	test('providers.json outranks the catalogue — a seeded off-switch does not win', () => {
		// The case that made the catalogue the weakest layer: a seeded `active: false` must not
		// switch off a provider the user enabled in their own file.
		const merged = mergeProviderLayers([
			[entry({ id: 'openai', active: false, baseURL: 'https://api.openai.com/v1' })],
			[],
			[entry({ id: 'openai', active: true })],
			[],
		]);
		assert.deepStrictEqual(merged, [{ id: 'openai', active: true, baseURL: 'https://api.openai.com/v1' }]);
	});

	test('the workspace catalogue outranks the global one', () => {
		const merged = mergeProviderLayers([
			[entry({ id: 'ollama', baseURL: 'http://home:11434/v1' })],
			[entry({ id: 'ollama', baseURL: 'http://project:11434/v1' })],
		]);
		assert.strictEqual(merged[0].baseURL, 'http://project:11434/v1');
	});

	test('models.static merges by model id across layers', () => {
		const merged = mergeProviderLayers([
			[entry({ id: 'p', models: { static: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] } })],
			[entry({ id: 'p', models: { static: [{ id: 'b', name: 'B patched' }, { id: 'c', name: 'C' }] } })],
		]);
		assert.deepStrictEqual(merged[0].models?.static, [
			{ id: 'a', name: 'A' },
			{ id: 'b', name: 'B patched' },
			{ id: 'c', name: 'C' },
		]);
	});

	test('models.fetch is a real tri-state — false survives, and true can override it', () => {
		// «not set» must differ from `true`: otherwise `fetch: true` layered onto `fetch: false`
		// is inexpressible, and a catalogue entry could never be re-enabled from providers.json.
		const off = mergeProviderLayers([
			[entry({ id: 'p', models: { fetch: false, static: [{ id: 'a' }] } })],
			[entry({ id: 'p', name: 'renamed' })],
		]);
		assert.strictEqual(off[0].models?.fetch, false, 'запись без models не должна включать fetch');

		const back = mergeProviderLayers([
			[entry({ id: 'p', models: { fetch: false } })],
			[entry({ id: 'p', models: { fetch: true } })],
		]);
		assert.strictEqual(back[0].models?.fetch, true);
	});

	test('inactive entries survive merging — they stay patchable and extendable', () => {
		// Filtering by `active` happens at the very end, in the consumers: an entry switched off in
		// the catalogue must still be visible to `extends` and to a later layer that revives it.
		const merged = mergeProviderLayers([
			[entry({ id: 'base', active: false, baseURL: 'https://base.example/v1', protocol: 'openai' })],
			[entry({ id: 'child', extends: 'base', name: 'Child' })],
		]);
		assert.deepStrictEqual(merged.map(e => e.id), ['base', 'child']);
		assert.strictEqual(merged[0].active, false);
	});

	test('catalogue bookkeeping files are not provider definitions', () => {
		assert.deepStrictEqual(
			['openai.jsonc', 'zz-local-toggles.jsonc', 'versions.json', 'deprecated.json', 'bump.mjs', 'README.md']
				.map(isProviderCatalogueFile),
			[true, true, false, false, false, false]);
	});
});
