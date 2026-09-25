/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, setBuiltinModelPatches, setExternalProviders } from '../../common/modelCapabilities.js';
import { builtinModelPatchesOf, modelEntryToCaps } from '../../browser/vibeDynamicProvidersService.js';

/**
 * A cache write that lives an hour costs more than a five-minute one, and the ledger bills what the model's
 * requests actually write: the hour rate for a model declared with `cacheTtl: "1h"`
 */
suite('hour cache write price', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		setExternalProviders([]);
		setBuiltinModelPatches({});
	});

	test('a file model with the hour bills cacheWrite1h, or twice the input when it is not declared', () => {
		setExternalProviders([{
			id: 'claude-file', source: 'file', modelCapOverrides: {
				'with-rate': modelEntryToCaps({ id: 'with-rate', cacheTtl: '1h', cost: { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 8 } }),
				'without-rate': modelEntryToCaps({ id: 'without-rate', cacheTtl: '1h', cost: { input: 5, output: 25, cacheWrite: 6.25 } }),
				'five-minutes': modelEntryToCaps({ id: 'five-minutes', cost: { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 8 } }),
			},
		}]);
		assert.deepStrictEqual(
			['with-rate', 'without-rate', 'five-minutes'].map(id => getModelCapabilities('claude-file', id, undefined).cost?.cache_write),
			[8, 10, 6.25],
		);
	});

	test('a file patching a built-in brings its models\' price and cache lifetime to the built-in', () => {
		const patches = builtinModelPatchesOf([
			{ id: 'claude-opus-5-5', cacheTtl: '1h', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 8 } },
			{ id: 'no-price-here', toolFormat: 'openai' },
		]);
		setBuiltinModelPatches({ anthropic: patches ?? {} });
		const caps = getModelCapabilities('anthropic', 'claude-opus-5-5', undefined);
		assert.deepStrictEqual(
			{ patched: Object.keys(patches ?? {}), ttl: caps.promptCacheTtl, write: caps.cost?.cache_write, read: caps.cost?.cache_read },
			{ patched: ['claude-opus-5-5'], ttl: '1h', write: 8, read: 0.5 },
		);
	});
});
