/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { getModelCapabilities, ModelCost } from '../../common/modelCapabilities.js';
import {
	byKey,
	byModel,
	byProvider,
	keySpendAnomalies,
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
	const PRICE: ModelCost = { input: 3, output: 15, cache_read: 0.3 };

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
		assert.strictEqual(Math.round(costOf(PRICE, { input: 1_000_000, output: 0, cacheRead: 800_000 })! * 100) / 100, 0.84);
	});

	/**
	 * The price exactly as the catalogue ships it. The ledger used to read a camelCase `cacheRead`
	 * the catalogue never had and billed every cached token at the full input rate — tenfold for
	 * Claude, silently, because this file fed `costOf` its own camelCase price.
	 */
	test('the catalogue price reaches the ledger with its cache rates', () => {
		const cost = getModelCapabilities('anthropic', 'claude-sonnet-4-5-20250929', undefined).cost;
		assert.deepStrictEqual({
			всёИзКэша: costOf(cost, { input: 1_000_000, output: 0, cacheRead: 1_000_000 }),
			всёВКэш: costOf(cost, { input: 1_000_000, output: 0, cacheWrite: 1_000_000 }),
		}, { всёИзКэша: cost.cache_read, всёВКэш: cost.cache_write });
	});

	/**
	 * Длинный промпт у GPT-6 Astra: больше 272K — вход и кэш вдвое, выход в полтора раза, и это цена
	 * всего запроса. Порог — по всему промпту; по сумме за прогон надбавку не решить.
	 */
	test('the long-prompt surcharge prices the whole request, only past the threshold, only per request', () => {
		const astra: ModelCost = { input: 10, output: 50, cache_read: 1, long_context: { over_input_tokens: 272_000, input: 2, cache: 2, output: 1.5 } };
		const long = { input: 300_000, output: 10_000, cacheRead: 100_000 };
		assert.deepStrictEqual({
			// 200k fresh × $10 × 2 + 100k cached × $1 × 2 + 10k out × $50 × 1.5 = 4 + 0.2 + 0.75.
			длинный: Math.round(costOf(astra, long)! * 100) / 100,
			ровноНаПороге: Math.round(costOf(astra, { input: 272_000, output: 0 })! * 100) / 100,
			суммаЗаПрогон: Math.round(costOf(astra, long, { aggregate: true })! * 100) / 100,
		}, { длинный: 4.95, ровноНаПороге: 2.72, суммаЗаПрогон: 2.6 });
	});

	test('cache writes are billed at the write rate; an undeclared rate falls back to input', () => {
		// 1M prompt: 600k fresh × $3 + 300k written × $3.75 + 100k read × $0.30 = 1.8 + 1.125 + 0.03.
		const withWrites: ModelCost = { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 };
		assert.deepStrictEqual({
			сЗаписью: Math.round(costOf(withWrites, { input: 1_000_000, output: 0, cacheRead: 100_000, cacheWrite: 300_000 })! * 1000) / 1000,
			безСтавкиЗаписи: costOf({ input: 3, output: 15 }, { input: 1_000_000, output: 0, cacheWrite: 1_000_000 }),
		}, { сЗаписью: 2.955, безСтавкиЗаписи: 3 });
	});

	test('unknown price stays unknown — never zero', () => {
		const state = recordSpend(emptyLedger(), {
			timestampMs: T0, providerId: 'mystery', modelId: 'unpriced',
			inputTokens: 5000, outputTokens: 5000,
		});

		assert.deepStrictEqual(
			[state.entries[0].costUsd, costOf(undefined, { input: 10, output: 10 }), costOf({ input: 0, output: 0 }, { input: 10, output: 10 })],
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

	suite('расход по ключу', () => {
		/** The seeded MiniMax pair: two provider entries, one key. */
		const keyRefOf = (providerId: string) => ({
			'minimax': 'minimax', 'minimax-anthropic': 'minimax', 'openai': 'openai',
		} as Record<string, string>)[providerId];

		const spend = (state: ReturnType<typeof emptyLedger>, at: number, providerId: string, outputTokens: number) =>
			recordSpend(state, { timestampMs: at, providerId, modelId: 'm', inputTokens: 0, outputTokens, price: PRICE });

		/** The whole reason this exists: per-provider rows split one key's spend and understate both. */
		test('two providers on one key collapse into one row', () => {
			let s = spend(emptyLedger(), T0, 'minimax', 100_000);
			s = spend(s, T0, 'minimax-anthropic', 100_000);
			const rows = byKey(s.entries, keyRefOf);
			assert.deepStrictEqual(rows.map(r => ({ key: r.keyRef, providers: r.providerIds, usd: r.totals.costUsd })), [
				{ key: 'minimax', providers: ['minimax', 'minimax-anthropic'], usd: 3 },
			]);
		});

		test('a provider with no key is dropped, not lumped under "unknown"', () => {
			const s = spend(emptyLedger(), T0, 'ollama-local', 100_000);
			assert.deepStrictEqual(byKey(s.entries, keyRefOf), []);
		});

		/** Today unlike the key's own fortnight — the only local signal that a key is being spent. */
		test('a threefold jump over the median is reported', () => {
			let s = emptyLedger();
			for (let d = 5; d >= 1; d--) { s = spend(s, T0 - d * DAY, 'openai', 100_000); }
			s = spend(s, T0, 'openai', 1_000_000);
			assert.deepStrictEqual(keySpendAnomalies(s, keyRefOf, T0).map(a => ({ key: a.keyRef, today: a.todayUsd, base: a.baselineUsd })), [
				{ key: 'openai', today: 15, base: 1.5 },
			]);
		});

		test('an ordinary busy day and a short history stay quiet', () => {
			let ordinary = emptyLedger();
			for (let d = 5; d >= 1; d--) { ordinary = spend(ordinary, T0 - d * DAY, 'openai', 100_000); }
			ordinary = spend(ordinary, T0, 'openai', 200_000);

			// Two days of history is not a baseline — the second day of use must not look anomalous.
			let fresh = spend(emptyLedger(), T0 - DAY, 'openai', 100_000);
			fresh = spend(fresh, T0, 'openai', 5_000_000);

			assert.deepStrictEqual({
				обычныйДень: keySpendAnomalies(ordinary, keyRefOf, T0).length,
				короткаяИстория: keySpendAnomalies(fresh, keyRefOf, T0).length,
			}, { обычныйДень: 0, короткаяИстория: 0 });
		});

		/**
		 * Days the key was not used at all are absent from the baseline rather than counted as zero:
		 * a fortnight of holidays would otherwise make the first working day an anomaly every time.
		 */
		test('idle days do not drag the baseline to zero', () => {
			let s = emptyLedger();
			for (const d of [12, 8, 3]) { s = spend(s, T0 - d * DAY, 'openai', 100_000); }
			s = spend(s, T0, 'openai', 200_000);
			assert.deepStrictEqual(keySpendAnomalies(s, keyRefOf, T0), []);
		});

		/** An unpriced bucket counted as zero would make a busy day look cheap — exactly backwards. */
		test('unpriced buckets are excluded rather than counted as free', () => {
			let s = emptyLedger();
			for (let d = 5; d >= 1; d--) { s = spend(s, T0 - d * DAY, 'openai', 100_000); }
			s = recordSpend(s, { timestampMs: T0, providerId: 'openai', modelId: 'm', inputTokens: 0, outputTokens: 9_000_000, price: undefined });
			assert.deepStrictEqual(keySpendAnomalies(s, keyRefOf, T0), []);
		});
	});
});
