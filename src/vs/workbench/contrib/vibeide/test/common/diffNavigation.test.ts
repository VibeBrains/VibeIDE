/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { diffIdxAfterResolve } from '../../common/diffNavigation.js';

/**
 * After accepting a change the next one must become current, not the one after it
 * A skipped change could be the critical one to reject
 */
suite('diff navigation — current change after a resolve', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the follower takes the turn, nothing is skipped', () => {
		assert.deepStrictEqual({
			first: diffIdxAfterResolve(0, 4),
			middle: diffIdxAfterResolve(2, 4),
			last: diffIdxAfterResolve(4, 4),
			noneLeft: diffIdxAfterResolve(0, 0),
		}, {
			first: 0,
			middle: 2,
			last: 3,
			noneLeft: null,
		});
	});
});
