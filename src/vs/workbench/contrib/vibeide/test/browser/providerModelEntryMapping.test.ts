/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { modelEntryToCaps, sortStaticModels } from '../../browser/vibeDynamicProvidersService.js';

/**
 * `.vibe/providers.json` → capabilities mapping.
 *
 * The failure this guards against is silence: a field can be declared in `VibeProviderModelEntry`,
 * documented in `docs/manuals/providersSpec.md` and suggested by the JSON schema, yet never read
 * by the mapper — so the user writes it, the editor autocompletes it, and nothing happens. It has
 * bitten twice: `fim` first, then `temperature`/`topP`/`topK`.
 */
suite('providers.json → model capabilities', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * `default` and `pinned` were declared in the format, used by our own shipped presets and read
	 * by nobody — the picker showed models in file order and auto-selected whatever happened to be
	 * first. Both flags land on the same lever: the settings service takes modelOptions[0] when a
	 * feature has no valid selection, so ordering IS the default-selection.
	 */
	test('default comes first, then pinned, then file order', () => {
		const ids = sortStaticModels([
			{ id: 'plain-a' },
			{ id: 'pinned-a', pinned: true },
			{ id: 'the-default', default: true },
			{ id: 'plain-b' },
			{ id: 'pinned-b', pinned: true },
		]).map(m => m.id);
		assert.deepStrictEqual(ids, ['the-default', 'pinned-a', 'pinned-b', 'plain-a', 'plain-b']);
	});

	test('order is stable when no flags are set — the file decides', () => {
		const ids = sortStaticModels([{ id: 'a' }, { id: 'b' }, { id: 'c' }]).map(m => m.id);
		assert.deepStrictEqual(ids, ['a', 'b', 'c']);
	});

	test('two defaults keep their written order — no silent reshuffle', () => {
		const ids = sortStaticModels([
			{ id: 'second', default: true },
			{ id: 'plain' },
			{ id: 'first-written', default: true },
		]).map(m => m.id);
		assert.deepStrictEqual(ids, ['second', 'first-written', 'plain']);
	});

	test('the input array is not mutated', () => {
		const input = [{ id: 'a' }, { id: 'z', default: true }];
		sortStaticModels(input);
		assert.deepStrictEqual(input.map(m => m.id), ['a', 'z']);
	});

	test('a fully populated entry maps every documented field', () => {
		const caps = modelEntryToCaps({
			id: 'some-model',
			contextWindow: 128000,
			maxOutputTokens: 8192,
			toolFormat: 'openai',
			vision: true,
			fim: true,
			systemMessage: 'system',
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 },
			temperature: 0.6,
			topP: 0.95,
			topK: 20,
			extraBody: { tool_stream: true },
		});

		assert.deepStrictEqual(caps, {
			contextWindow: 128000,
			reservedOutputTokenSpace: 8192,
			specialToolFormat: 'openai-style',
			supportsVision: true,
			supportsFIM: true,
			supportsSystemMessage: 'system-role',
			cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 3 },
			additionalOpenAIPayload: { tool_stream: true },
			defaultTemperature: 0.6,
			defaultTopP: 0.95,
			defaultTopK: 20,
		});
	});

	test('sampling fields survive on their own — this is the regression', () => {
		assert.deepStrictEqual(
			modelEntryToCaps({ id: 'm', temperature: 0.55, topP: 1, topK: 40 }),
			{ defaultTemperature: 0.55, defaultTopP: 1, defaultTopK: 40 },
		);
	});

	test('omitted fields stay omitted — no zero-value defaults leak in', () => {
		assert.deepStrictEqual(modelEntryToCaps({ id: 'm' }), {});
	});

	test('temperature 0 is a value, not "absent"', () => {
		// A `typeof === 'number'` check keeps 0 alive; a truthiness check would drop it and
		// silently hand the model the provider default instead of the requested determinism.
		assert.deepStrictEqual(
			modelEntryToCaps({ id: 'm', temperature: 0, topP: 0 }),
			{ defaultTemperature: 0, defaultTopP: 0 },
		);
	});
});
