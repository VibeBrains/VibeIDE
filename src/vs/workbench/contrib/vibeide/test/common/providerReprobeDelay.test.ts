/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { reprobeDelayMs } from '../../common/providerReprobeDelay.js';

suite('providerReprobeDelay — пауза повторного опроса недоступного провайдера', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('удваивается от десяти секунд и упирается в пять минут', () => {
		assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 50].map(reprobeDelayMs),
			[10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
	});
});
