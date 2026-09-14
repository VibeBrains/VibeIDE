/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPeakAt, nextOffPeakMoment, parseTimeOfDay, PriceTimeOfDay, timeOfDayFactorAt } from '../../common/modelPriceSchedule.js';
import { costOf } from '../../common/spendLedger.js';

/**
 * Цена по часу: расписание DeepSeek (пик 01:00–04:00 и 06:00–10:00 UTC по будням, вне пика ×0.5).
 */
suite('modelPriceSchedule — цена по часу', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const deepseek = parseTimeOfDay({ peakUtc: ['01:00-04:00', '06:00-10:00'], peakDays: ['mon', 'tue', 'wed', 'thu', 'fri'], offPeakFactor: 0.5 }) as PriceTimeOfDay;
	// 2026-09-14 is a Monday, 2026-09-13 a Sunday.
	const at = (iso: string) => Date.parse(iso);

	test('разбор: расписание, полночь, пустое и битые блоки', () => {
		assert.deepStrictEqual([
			deepseek,
			parseTimeOfDay({ peakUtc: ['22:00-02:00', '20:00-24:00'], offPeakFactor: 0.8 }),
			parseTimeOfDay(undefined),
			parseTimeOfDay({ peakUtc: ['01:00-04:00'], offPeakFactor: 1 }),
			parseTimeOfDay({ peakUtc: ['01:00-04:00', '25:00-26:00'], offPeakFactor: 0.5 }),
			parseTimeOfDay({ peakUtc: ['01:00-04:00'], peakDays: ['понедельник'], offPeakFactor: 0.5 }),
			parseTimeOfDay({ peakUtc: [], offPeakFactor: 0.5 }),
			parseTimeOfDay({ peakUtc: ['24:00-02:00'], offPeakFactor: 0.5 }),
		], [
			{ windows: [{ from: 60, to: 240 }, { from: 360, to: 600 }], days: [1, 2, 3, 4, 5], offPeakFactor: 0.5 },
			{ windows: [{ from: 1320, to: 120 }, { from: 1200, to: 0 }], days: [], offPeakFactor: 0.8 },
			undefined,
			undefined,
			'invalid',
			'invalid',
			'invalid',
			'invalid',
		]);
	});

	test('пик, множитель и ближайшее дешёвое время', () => {
		const night = parseTimeOfDay({ peakUtc: ['22:00-02:00'], offPeakFactor: 0.5 }) as PriceTimeOfDay;
		assert.deepStrictEqual([
			isPeakAt(deepseek, at('2026-09-14T01:00:00Z')),
			isPeakAt(deepseek, at('2026-09-14T04:00:00Z')),
			isPeakAt(deepseek, at('2026-09-13T07:00:00Z')),
			isPeakAt(night, at('2026-09-14T23:30:00Z')),
			isPeakAt(night, at('2026-09-14T01:59:00Z')),
			timeOfDayFactorAt(deepseek, at('2026-09-14T12:00:00Z')),
			timeOfDayFactorAt(deepseek, at('2026-09-14T07:00:00Z')),
			timeOfDayFactorAt(deepseek, undefined),
			nextOffPeakMoment(deepseek, at('2026-09-14T07:15:30Z')),
			nextOffPeakMoment(deepseek, at('2026-09-14T12:00:00Z')),
			nextOffPeakMoment(parseTimeOfDay({ peakUtc: ['00:00-12:00', '12:00-24:00'], offPeakFactor: 0.5 }) as PriceTimeOfDay, at('2026-09-14T12:00:00Z')),
		], [true, false, false, true, true, 0.5, 1, 1, at('2026-09-14T10:00:00Z'), at('2026-09-14T12:00:00Z'), undefined]);
	});

	test('стоимость хода: вне пика вдвое дешевле, без момента — по пику', () => {
		const price = { input: 0.30, output: 1.20, cache_read: 0.006, time_of_day: deepseek };
		const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 0 };
		assert.deepStrictEqual(
			[costOf(price, tokens, { at: at('2026-09-14T07:00:00Z') }), costOf(price, tokens, { at: at('2026-09-14T12:00:00Z') }), costOf(price, tokens)],
			[1.5, 0.75, 1.5],
		);
	});
});
