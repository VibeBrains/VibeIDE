/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	byModel,
	byProvider,
	costOf,
	dayKey,
	emptyLedger,
	entriesInWindow,
	parseLedger,
	recordSpend,
	SPEND_RETENTION_DAYS,
	totalsOf,
} from '../../common/spendLedger.js';

suite('spendLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const DAY = 24 * 60 * 60 * 1000;
	// Fixed local noon, so a timezone shift cannot move the entry to the neighbouring day.
	const T0 = new Date(2026, 6, 30, 12, 0, 0).getTime();
	const PRICE = { input: 3, output: 15, cacheRead: 0.3 };

	test('one exchange becomes one bucket with the cost the price implies', () => {
		const state = recordSpend(emptyLedger(), {
			timestampMs: T0, providerId: 'anthropic', modelId: 'claude-x',
			inputTokens: 1_000_000, outputTokens: 100_000, price: PRICE,
		});

		assert.deepStrictEqual(state.entries, [{
			day: dayKey(T0),
			providerId: 'anthropic',
			modelId: 'claude-x',
			requests: 1,
			inputTokens: 1_000_000,
			outputTokens: 100_000,
			cachedInputTokens: 0,
			costUsd: 3 + 1.5,
		}]);
	});

	test('cache hits are billed at the cache rate, not the input rate', () => {
		// 1M input of which 800k came from cache: 200k × $3 + 800k × $0.30 = 0.6 + 0.24.
		// Rounded to cents on purpose — binary floating point makes 0.6 + 0.24 land on
		// 0.8400000000000001, and money is never compared with strict equality.
		assert.strictEqual(Math.round(costOf(PRICE, 1_000_000, 0, 800_000)! * 100) / 100, 0.84);
	});

	test('unknown price stays unknown — never zero', () => {
		const state = recordSpend(emptyLedger(), {
			timestampMs: T0, providerId: 'mystery', modelId: 'unpriced',
			inputTokens: 5000, outputTokens: 5000,
		});

		assert.deepStrictEqual(
			[state.entries[0].costUsd, costOf(undefined, 10, 10), costOf({ input: 0, output: 0 }, 10, 10)],
			[undefined, undefined, undefined],
		);
	});

	test('a priced exchange in an unpriced bucket reports what is known', () => {
		let state = recordSpend(emptyLedger(), {
			timestampMs: T0, providerId: 'p', modelId: 'm', inputTokens: 1000, outputTokens: 1000,
		});
		state = recordSpend(state, {
			timestampMs: T0, providerId: 'p', modelId: 'm', inputTokens: 1_000_000, outputTokens: 0, price: PRICE,
		});

		assert.deepStrictEqual(
			[state.entries.length, state.entries[0].requests, state.entries[0].costUsd],
			[1, 2, 3],
		);
	});

	test('same day, same model accumulates; another model is its own bucket', () => {
		let state = recordSpend(emptyLedger(), { timestampMs: T0, providerId: 'p', modelId: 'a', inputTokens: 10, outputTokens: 5, price: PRICE });
		state = recordSpend(state, { timestampMs: T0 + 1000, providerId: 'p', modelId: 'a', inputTokens: 10, outputTokens: 5, price: PRICE });
		state = recordSpend(state, { timestampMs: T0 + 2000, providerId: 'p', modelId: 'b', inputTokens: 10, outputTokens: 5, price: PRICE });

		assert.deepStrictEqual(
			state.entries.map(e => `${e.modelId}:${e.requests}`),
			['a:2', 'b:1'],
		);
	});

	test('windows and grouping answer "which key is eating the budget"', () => {
		let state = emptyLedger();
		state = recordSpend(state, { timestampMs: T0, providerId: 'anthropic', modelId: 'big', inputTokens: 1_000_000, outputTokens: 0, price: PRICE });
		state = recordSpend(state, { timestampMs: T0 - 2 * DAY, providerId: 'openai', modelId: 'small', inputTokens: 100_000, outputTokens: 0, price: { input: 1, output: 2 } });
		state = recordSpend(state, { timestampMs: T0 - 20 * DAY, providerId: 'openai', modelId: 'old', inputTokens: 1_000_000, outputTokens: 0, price: { input: 1, output: 2 } });

		const week = entriesInWindow(state, T0, 7);
		assert.deepStrictEqual(
			[
				byProvider(week).map(p => p.providerId),
				Math.round(totalsOf(week).costUsd * 100) / 100,
				byModel(week).map(m => m.modelId),
				entriesInWindow(state, T0, 30).length,
			],
			[['anthropic', 'openai'], 3.1, ['big', 'small'], 3],
		);
	});

	test('totals flag an unpriced bucket instead of hiding it', () => {
		let state = recordSpend(emptyLedger(), { timestampMs: T0, providerId: 'p', modelId: 'priced', inputTokens: 1_000_000, outputTokens: 0, price: PRICE });
		state = recordSpend(state, { timestampMs: T0, providerId: 'p', modelId: 'unpriced', inputTokens: 1_000_000, outputTokens: 0 });

		const totals = totalsOf(state.entries);
		assert.deepStrictEqual([totals.costUsd, totals.hasUnpriced, totals.requests], [3, true, 2]);
	});

	test('history older than the retention window is dropped on write', () => {
		let state = recordSpend(emptyLedger(), {
			timestampMs: T0 - (SPEND_RETENTION_DAYS + 5) * DAY, providerId: 'p', modelId: 'ancient', inputTokens: 10, outputTokens: 10, price: PRICE,
		});
		assert.strictEqual(state.entries.length, 1);

		state = recordSpend(state, { timestampMs: T0, providerId: 'p', modelId: 'fresh', inputTokens: 10, outputTokens: 10, price: PRICE });
		assert.deepStrictEqual(state.entries.map(e => e.modelId), ['fresh']);
	});

	test('persisted state round-trips; garbage degrades to an empty ledger', () => {
		const state = recordSpend(emptyLedger(), { timestampMs: T0, providerId: 'p', modelId: 'm', inputTokens: 10, outputTokens: 10, price: PRICE });

		assert.deepStrictEqual(
			[
				parseLedger(JSON.stringify(state)),
				parseLedger('not json'),
				parseLedger(JSON.stringify({ version: 99, entries: [] })),
				parseLedger(undefined),
			],
			[state, emptyLedger(), emptyLedger(), emptyLedger()],
		);
	});

	test('a corrupted entry is dropped, the rest of the history survives', () => {
		const raw = JSON.stringify({
			version: 1,
			entries: [
				{ day: '2026-07-30', providerId: 'p', modelId: 'good', requests: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 1 },
				{ day: '2026-07-30', modelId: 'no-provider', requests: 1, inputTokens: 1, outputTokens: 1 },
			],
		});

		assert.deepStrictEqual(parseLedger(raw).entries.map(e => e.modelId), ['good']);
	});
});
