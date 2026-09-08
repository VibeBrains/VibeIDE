/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	chargeRoundTrip, deserializeToolCost, EMPTY_LIVE_WEIGHTS, EMPTY_TOOL_COST_TOTALS, recordToolResult,
	serializeToolCost, ToolCostTotals, totalContextCost, TurnLiveWeights, worstOffenders,
} from '../../common/toolContextCost.js';

/**
 * Контекстный налог.
 *
 * The accounting exists to answer one question — which tool's output is being paid for over and
 * over — so the tests pin the ways that answer could quietly be wrong: charging a result for
 * round-trips that happened before it existed, letting a finished turn keep billing, and mixing two
 * conversations that carry two different context windows.
 */
suite('tool context cost', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Characters worth this many tokens, by the ratio the prompt estimator uses. */
	const chars = (tokens: number) => tokens * 4;

	/** One conversation's state, so a test reads like the turn it describes. */
	class Turn {
		constructor(public totals: ToolCostTotals = EMPTY_TOOL_COST_TOTALS, public live: TurnLiveWeights = EMPTY_LIVE_WEIGHTS) { }
		result(tool: string, tokens: number): this {
			const next = recordToolResult(this.totals, this.live, tool, chars(tokens));
			this.totals = next.totals;
			this.live = next.live;
			return this;
		}
		roundTrip(): this {
			this.totals = chargeRoundTrip(this.totals, this.live);
			return this;
		}
		/** What the service does when a thread goes idle: the window is gone, the totals stay. */
		end(): this {
			this.live = EMPTY_LIVE_WEIGHTS;
			return this;
		}
	}

	test('a result is paid once, then again for every later round-trip', () => {
		const turn = new Turn().result('read_file', 1000).roundTrip().roundTrip();
		assert.deepStrictEqual(
			worstOffenders(turn.totals, 5),
			[{ tool: 'read_file', calls: 1, produced: 1000, carried: 2000 }],
		);
	});

	/** Charging a result for round-trips that happened before it existed would invent a tax. */
	test('only round-trips after the result count', () => {
		const turn = new Turn().roundTrip().result('search', 100);
		assert.deepStrictEqual(totalContextCost(turn.totals), { produced: 100, carried: 0 });
	});

	test('the turn ending stops the billing but keeps the totals', () => {
		const turn = new Turn().result('read_file', 500).roundTrip().end().roundTrip();
		assert.deepStrictEqual(totalContextCost(turn.totals), { produced: 500, carried: 500 });
	});

	/**
	 * Two chat tabs carry two context windows. Sharing one live map would let one thread's round-trip
	 * bill the other's results — the reason the weights are keyed by conversation.
	 */
	test('two conversations do not pay for each other', () => {
		let totals = EMPTY_TOOL_COST_TOTALS;
		const first = recordToolResult(totals, EMPTY_LIVE_WEIGHTS, 'read_file', chars(1000));
		totals = first.totals;
		const second = recordToolResult(totals, EMPTY_LIVE_WEIGHTS, 'search', chars(100));
		totals = second.totals;

		// Only the first conversation sends a request.
		totals = chargeRoundTrip(totals, first.live);
		assert.deepStrictEqual(
			worstOffenders(totals, 5),
			[
				{ tool: 'read_file', calls: 1, produced: 1000, carried: 1000 },
				{ tool: 'search', calls: 1, produced: 100, carried: 0 },
			],
		);
	});

	/**
	 * The ordering is the whole report: one heavy read early in a long turn must outrank a chatty
	 * tool called at the very end, because only the first is worth changing.
	 */
	test('the heaviest overall comes first', () => {
		const turn = new Turn().result('read_file', 1000).roundTrip().roundTrip().result('list_dir', 1500);
		assert.deepStrictEqual(worstOffenders(turn.totals, 5).map(t => t.tool), ['read_file', 'list_dir']);
	});

	test('an empty result changes nothing', () => {
		const next = recordToolResult(EMPTY_TOOL_COST_TOTALS, EMPTY_LIVE_WEIGHTS, 'noop', 0);
		assert.strictEqual(next.totals, EMPTY_TOOL_COST_TOTALS);
	});

	/** Live weights must not come back from storage: a past turn carries nothing now. */
	test('totals survive a round trip through storage, live weight does not', () => {
		const turn = new Turn().result('read_file', 200).roundTrip();
		const restored = deserializeToolCost(JSON.parse(JSON.stringify(serializeToolCost(turn.totals))));
		assert.deepStrictEqual(totalContextCost(chargeRoundTrip(restored, EMPTY_LIVE_WEIGHTS)), { produced: 200, carried: 200 });
		assert.deepStrictEqual(totalContextCost(deserializeToolCost('мусор')), { produced: 0, carried: 0 });
	});
});
