/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { compareAgentRunFences, formatAgentRunEpoch, isAgentRunFence, isFenceSuperseded, nextAgentRunFence } from '../../common/agentRunFence.js';

const OLD_WINDOW = { windowStartedAtMs: 1_000, seq: 7 };
const SAME_WINDOW_LATER = { windowStartedAtMs: 1_000, seq: 8 };
const NEW_WINDOW = { windowStartedAtMs: 2_000, seq: 1 };

suite('agentRunFence — run ownership across windows', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ordering: newer window wins over any seq; inside one window seq decides', () => {
		assert.deepStrictEqual(
			[
				Math.sign(compareAgentRunFences(OLD_WINDOW, NEW_WINDOW)),
				Math.sign(compareAgentRunFences(NEW_WINDOW, OLD_WINDOW)),
				Math.sign(compareAgentRunFences(OLD_WINDOW, SAME_WINDOW_LATER)),
				Math.sign(compareAgentRunFences(OLD_WINDOW, OLD_WINDOW)),
			],
			[-1, 1, -1, 0],
		);
	});

	test('supersede: a stale window is refused, the current owner and equal fences are not', () => {
		assert.deepStrictEqual(
			[
				isFenceSuperseded(OLD_WINDOW, NEW_WINDOW),
				isFenceSuperseded(NEW_WINDOW, OLD_WINDOW),
				isFenceSuperseded(OLD_WINDOW, OLD_WINDOW),
			],
			[true, false, false],
		);
	});

	test('next fence increments inside the window; negative history cannot lower it', () => {
		assert.deepStrictEqual(
			[nextAgentRunFence(2_000, 0), nextAgentRunFence(2_000, 4), nextAgentRunFence(2_000, -9)],
			[{ windowStartedAtMs: 2_000, seq: 1 }, { windowStartedAtMs: 2_000, seq: 5 }, { windowStartedAtMs: 2_000, seq: 1 }],
		);
	});

	test('epoch id is stable per window+salt; fence guard rejects junk from disk', () => {
		assert.deepStrictEqual(
			[
				formatAgentRunEpoch(1_000, 'abc'),
				formatAgentRunEpoch(1_000, 'abc') === formatAgentRunEpoch(1_000, 'xyz'),
				isAgentRunFence(OLD_WINDOW),
				isAgentRunFence({ windowStartedAtMs: 'nope', seq: 1 }),
				isAgentRunFence(null),
				isAgentRunFence({ seq: 1 }),
			],
			['rs-abc', false, true, false, false, false],
		);
	});
});
