/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { visibleProviderCards } from '../../common/providerCardVisibility.js';

suite('Provider card visibility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const local = new Set(['ollama', 'vLLM', 'lmStudio']);
	const run = (models: Record<string, number>, showEmptyLocal: boolean) => visibleProviderCards({
		configured: Object.keys(models),
		modelCountOf: p => models[p] ?? 0,
		isLocal: p => local.has(p),
		showEmptyLocal,
	});

	test('empty local providers are hidden, used ones and cloud stay', () => {
		assert.deepStrictEqual(
			run({ anthropic: 0, ollama: 0, vLLM: 3, lmStudio: 0 }, false),
			['anthropic', 'vLLM'],
		);
	});

	test('the escape hatch brings every configured provider back, in order', () => {
		assert.deepStrictEqual(
			run({ anthropic: 0, ollama: 0, vLLM: 3 }, true),
			['anthropic', 'ollama', 'vLLM'],
		);
	});

	test('a cloud provider with no models is never hidden — it was configured by hand', () => {
		assert.deepStrictEqual(run({ anthropic: 0 }, false), ['anthropic']);
	});

	test('all-empty-local leaves nothing visible (the caller must still render the toggle)', () => {
		assert.deepStrictEqual(run({ ollama: 0, lmStudio: 0 }, false), []);
	});
});
