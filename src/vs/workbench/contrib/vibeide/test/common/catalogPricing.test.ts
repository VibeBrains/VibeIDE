/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { normaliseCatalogCost, parseCatalogPrice, perMillionFromPerToken } from '../../common/catalogPricing.js';

suite('catalogPricing — aggregators quote per token, we speak per million', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('LiteLLM per-token number becomes per-million', () => {
		// 0.000003 $/token = $3 per million — the number a human recognises as a mid-tier model.
		assert.strictEqual(perMillionFromPerToken(0.000003), 3);
	});

	test('OpenRouter sends strings — they parse instead of leaking into a numeric field', () => {
		assert.deepStrictEqual(
			[perMillionFromPerToken('0.000003'), perMillionFromPerToken(' 0.0000015 '), parseCatalogPrice('нет')],
			[3, 1.5, undefined],
		);
	});

	test('zero is a price, not missing data — local providers really are free', () => {
		assert.deepStrictEqual(normaliseCatalogCost(0, 0), { input: 0, output: 0 });
	});

	test('an implausible number is dropped rather than trusted — a wrong price beats no price only in appearance', () => {
		// A catalog that already quotes per million (3) would become $3 000 000/M if multiplied again.
		assert.deepStrictEqual(
			[perMillionFromPerToken(3), perMillionFromPerToken(-1), perMillionFromPerToken(Infinity)],
			[undefined, undefined, undefined],
		);
	});

	test('a half-known pair is dropped whole — "input $3, output free" reads as a bargain', () => {
		assert.deepStrictEqual(
			[normaliseCatalogCost(0.000003, undefined), normaliseCatalogCost(undefined, 0.000003), normaliseCatalogCost(0.000003, '0.000015')],
			[undefined, undefined, { input: 3, output: 15 }],
		);
	});
});
