/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	chargeRoundTrip, deserializeToolCost, EMPTY_TOOL_COST_STATE, endTurn, recordToolResult,
	serializeToolCost, totalContextCost, worstOffenders,
} from '../../common/toolContextCost.js';

/**
 * Контекстный налог.
 *
 * The accounting exists to answer one question — which tool's output is being paid for over and
 * over — so the tests pin the two ways that answer could quietly be wrong: charging a result for
 * round-trips that happened before it existed, and letting a finished turn keep billing.
 */
suite('tool context cost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Characters worth this many tokens, by the ratio the prompt estimator uses. */
	const chars = (tokens: number) => tokens * 4;

	test('a result is paid once, then again for every later round-trip', () => {
		let state = recordToolResult(EMPTY_TOOL_COST_STATE, 'read_file', chars(1000));
		state = chargeRoundTrip(state);
		state = chargeRoundTrip(state);
		assert.deepStrictEqual(
			worstOffenders(state, 5),
			[{ tool: 'read_file', calls: 1, produced: 1000, carried: 2000 }],
		);
	});

	/** Charging a result for round-trips that happened before it existed would invent a tax. */
	test('only round-trips after the result count', () => {
		let state = chargeRoundTrip(EMPTY_TOOL_COST_STATE);
		state = recordToolResult(state, 'search', chars(100));
		assert.deepStrictEqual(totalContextCost(state), { produced: 100, carried: 0 });
	});

	test('the turn ending stops the billing but keeps the totals', () => {
		let state = recordToolResult(EMPTY_TOOL_COST_STATE, 'read_file', chars(500));
		state = chargeRoundTrip(state);
		state = endTurn(state);
		state = chargeRoundTrip(state);
		assert.deepStrictEqual(totalContextCost(state), { produced: 500, carried: 500 });
	});

	/**
	 * The ordering is the whole report: one heavy read early in a long turn must outrank a chatty
	 * tool called at the very end, because only the first is worth changing.
	 */
	test('the heaviest overall comes first', () => {
		let state = recordToolResult(EMPTY_TOOL_COST_STATE, 'read_file', chars(1000));
		state = chargeRoundTrip(state);
		state = chargeRoundTrip(state);
		state = recordToolResult(state, 'list_dir', chars(1500));
		assert.deepStrictEqual(worstOffenders(state, 5).map(t => t.tool), ['read_file', 'list_dir']);
	});

	test('an empty result changes nothing', () => {
		assert.strictEqual(recordToolResult(EMPTY_TOOL_COST_STATE, 'noop', 0), EMPTY_TOOL_COST_STATE);
	});

	/** Live weights must not come back from storage: a past turn carries nothing now. */
	test('totals survive a round trip through storage, live weight does not', () => {
		let state = recordToolResult(EMPTY_TOOL_COST_STATE, 'read_file', chars(200));
		state = chargeRoundTrip(state);
		const restored = deserializeToolCost(JSON.parse(JSON.stringify(serializeToolCost(state))));
		assert.deepStrictEqual(totalContextCost(chargeRoundTrip(restored)), { produced: 200, carried: 200 });
		assert.deepStrictEqual(totalContextCost(deserializeToolCost('мусор')), { produced: 0, carried: 0 });
	});
});
