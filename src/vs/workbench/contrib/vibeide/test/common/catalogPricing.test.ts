/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { longContextFromOverrides, normaliseCatalogCost, parseCatalogPrice, perMillionFromPerToken, timeOfDayFromOverrides } from '../../common/catalogPricing.js';

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

	test('the whole OpenRouter price survives: cache rates and the long-prompt tier as multipliers', () => {
		// Verbatim from https://openrouter.ai/api/v1/models for sakana/fugu-ultra, 12.09.2026.
		assert.deepStrictEqual(
			normaliseCatalogCost('0.000005', '0.00003', {
				cacheRead: '0.0000005',
				cacheWrite: undefined,
				overrides: [{ min_prompt_tokens: 272000, prompt: '0.00001', completion: '0.000045', input_cache_read: '0.000001' }],
			}),
			{ input: 5, output: 30, cache_read: 0.5, long_context: { over_input_tokens: 272_000, input: 2, output: 1.5, cache: 2 } },
		);
	});

	test('a time-based override is not a long-prompt tier — an off-peak discount must not become a surcharge', () => {
		assert.deepStrictEqual(
			[
				longContextFromOverrides({ input: 5, output: 30 }, [{ utc_days: [0, 6], prompt: '0.0000025', completion: '0.000015' }]),
				longContextFromOverrides({ input: 5, output: 30 }, [{ utc_start: 1, utc_end: 5, prompt: '0.0000025', completion: '0.000015' }]),
				longContextFromOverrides({ input: 5, output: 30 }, undefined),
			],
			[undefined, undefined, undefined],
		);
	});

	test('several prompt tiers — the lowest threshold wins, because that is the step a request crosses first', () => {
		assert.deepStrictEqual(
			longContextFromOverrides({ input: 5, output: 30 }, [
				{ min_prompt_tokens: 500000, prompt: '0.00002', completion: '0.00009' },
				{ min_prompt_tokens: 272000, prompt: '0.00001', completion: '0.000045' },
			]),
			{ over_input_tokens: 272_000, input: 2, output: 1.5 },
		);
	});

	test('a tier that changes nothing is not carried — it would cost a comparison on every priced exchange', () => {
		assert.strictEqual(
			longContextFromOverrides({ input: 5, output: 30 }, [{ min_prompt_tokens: 272000, prompt: '0.000005', completion: '0.00003' }]),
			undefined,
		);
	});

	test('расписание по часу OpenRouter (DeepSeek V4.1 Flash, 17.09.2026) становится пиковыми ставками и time_of_day', () => {
		const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
		const off = { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000003' };
		const peak = { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.000000006' };
		const overrides = [
			{ utc_days: ['saturday', 'sunday'], ...off },
			{ utc_days: weekdays, utc_start: 0, utc_end: 100, ...off },
			{ utc_days: weekdays, utc_start: 100, utc_end: 400, ...peak },
			{ utc_days: weekdays, utc_start: 400, utc_end: 600, ...off },
			{ utc_days: weekdays, utc_start: 600, utc_end: 1000, ...peak },
			{ utc_days: weekdays, utc_start: 1000, utc_end: 0, ...off },
		];
		const cost = normaliseCatalogCost('0.00000015', '0.0000006', { cacheRead: '0.000000003', overrides });
		assert.deepStrictEqual(cost, {
			input: perMillionFromPerToken('0.0000003'), output: perMillionFromPerToken('0.0000012'), cache_read: perMillionFromPerToken('0.000000006'),
			time_of_day: { windows: [{ from: 60, to: 240 }, { from: 360, to: 600 }], days: [1, 2, 3, 4, 5], offPeakFactor: 0.5 },
		});
	});

	test('противоречивое расписание не приближается: разный множитель, разные дни, скидка вместо надбавки', () => {
		const base = { input: 1, output: 2 };
		assert.deepStrictEqual([
			timeOfDayFromOverrides(base, [{ utc_days: ['monday'], utc_start: 100, utc_end: 200, prompt: '0.000002', completion: '0.000006' }]),
			timeOfDayFromOverrides(base, [
				{ utc_days: ['monday'], utc_start: 100, utc_end: 200, prompt: '0.000002', completion: '0.000004' },
				{ utc_days: ['tuesday'], utc_start: 300, utc_end: 400, prompt: '0.000002', completion: '0.000004' },
			]),
			timeOfDayFromOverrides(base, [{ utc_days: ['monday'], utc_start: 100, utc_end: 200, prompt: '0.0000005', completion: '0.000001' }]),
			timeOfDayFromOverrides(base, undefined),
		], [undefined, undefined, undefined, undefined]);
	});
});
