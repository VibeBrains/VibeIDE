/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dynamicKeyGate, DynamicKeyGateInput } from '../../browser/vibeDynamicProvidersService.js';
import { DynamicKeyValidation } from '../../common/remoteCatalogService.js';

/**
 * Which models a provider from `.vibe/providers` offers, and what its card says
 *
 * The failure this guards against: a server declared `"auth": "none"` was gated like a provider missing its key —
 * the probe never ran and the model list stayed empty until a dummy key was planted
 */
suite('dynamic provider key gate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const ok: DynamicKeyValidation = { status: 'ok', models: [] };
	const unauthorized: DynamicKeyValidation = { status: 'unauthorized', models: [] };
	const unreachable: DynamicKeyValidation = { status: 'error', models: [] };
	const base: DynamicKeyGateInput = { keyless: false, hasBrowserKey: false, hasOsEnvKey: false, staticOnly: false, validation: undefined };

	test('a keyless server is probed like a key: its answer decides, a key in the environment changes nothing', () => {
		const cases: Array<Partial<DynamicKeyGateInput>> = [
			{ keyless: true },
			{ keyless: true, validation: ok },
			{ keyless: true, validation: unauthorized },
			{ keyless: true, validation: unreachable },
			{ keyless: true, staticOnly: true },
			{ keyless: true, hasOsEnvKey: true },
			{},
			{ hasOsEnvKey: true },
			{ hasBrowserKey: true, validation: ok },
			{ hasBrowserKey: true, validation: unauthorized },
		];
		assert.deepStrictEqual(cases.map(c => dynamicKeyGate({ ...base, ...c })), [
			{ keyStatus: 'pending', offer: 'none' },
			{ keyStatus: 'valid', offer: 'catalog' },
			{ keyStatus: 'invalid', offer: 'none' },
			{ keyStatus: 'error', offer: 'none' },
			{ keyStatus: 'unverified', offer: 'static' },
			{ keyStatus: 'pending', offer: 'none' },
			{ keyStatus: 'none', offer: 'none' },
			{ keyStatus: 'unverified', offer: 'static' },
			{ keyStatus: 'valid', offer: 'catalog' },
			{ keyStatus: 'invalid', offer: 'none' },
		]);
	});
});
