/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	effectiveCost, nextPriceChangeMoment, parseDeclaredMoment, priceChangeStatus, PRICE_CHANGE_SOON_DAYS,
} from '../../common/modelPriceSchedule.js';

/**
 * Цена со сроком годности.
 *
 * The failure this guards against is silent by nature: a promotional rate that expired keeps being
 * used, the spend report stays cheerful, and the user learns the real number from the vendor's
 * invoice — the one place we cannot correct afterwards.
 */
suite('model price schedule', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const promo = { input: 0.03, output: 0.12 };
	const full = { input: 0.30, output: 1.20 };
	const deadline = '2026-09-10T23:59:00Z';
	const before = Date.parse('2026-09-10T20:00:00Z');
	const after = Date.parse('2026-09-11T00:30:00Z');

	test('the rate in effect follows the clock', () => {
		assert.deepStrictEqual(effectiveCost(promo, deadline, full, before), promo);
		assert.deepStrictEqual(effectiveCost(promo, deadline, full, after), full);
	});

	/** A date alone says a promotion ends but not what replaces it — inventing a number is worse. */
	test('a schedule without a replacement price changes nothing', () => {
		assert.deepStrictEqual(effectiveCost(promo, deadline, undefined, after), promo);
		assert.strictEqual(priceChangeStatus(promo, deadline, undefined, after), undefined);
	});

	test('an unparsable date leaves the current price alone and says nothing', () => {
		assert.deepStrictEqual(effectiveCost(promo, 'скоро', full, after), promo);
		assert.strictEqual(priceChangeStatus(promo, 'скоро', full, after), undefined);
	});

	/**
	 * The vendor deadline that prompted this field is «24:00 UTC+8 on September 9». Rounded to a
	 * bare date it lands most of a day late — in the direction that costs money.
	 */
	test('an offset in the declared moment is honoured', () => {
		const moment = parseDeclaredMoment('2026-09-09T24:00:00+08:00');
		assert.strictEqual(moment, Date.parse('2026-09-09T16:00:00Z'));
		assert.strictEqual(parseDeclaredMoment('2026-09-25'), Date.parse('2026-09-25T00:00:00Z'));
		assert.strictEqual(parseDeclaredMoment(undefined), undefined);
	});

	test('severity and the multiplier are what makes the warning worth reading', () => {
		assert.deepStrictEqual(
			priceChangeStatus(promo, deadline, full, Date.parse('2026-09-09T23:59:00Z'), 'из блога вендора'),
			{ severity: 'soon', daysLeft: 1, inputMultiplier: 10, outputMultiplier: 10, note: 'из блога вендора' },
		);
		assert.strictEqual(priceChangeStatus(promo, deadline, full, after)?.severity, 'in-effect');
		const far = Date.parse('2026-09-10T23:59:00Z') - (PRICE_CHANGE_SOON_DAYS + 2) * 86_400_000;
		assert.strictEqual(priceChangeStatus(promo, deadline, full, far)?.severity, 'announced');
	});

	/** Free → paid has no ratio, and reporting Infinity would be worse than reporting nothing. */
	test('a rise from free reports no multiplier', () => {
		const status = priceChangeStatus({ input: 0, output: 0 }, '2026-09-25', { input: 0.06, output: 0.18 }, Date.parse('2026-09-20T00:00:00Z'));
		assert.deepStrictEqual(
			[status?.severity, status?.inputMultiplier, status?.outputMultiplier],
			['soon', undefined, undefined],
		);
	});

	test('the next moment is the soonest one still ahead', () => {
		const now = Date.parse('2026-09-08T00:00:00Z');
		const moment = nextPriceChangeMoment([
			{ validUntil: '2026-09-25', costAfter: full },
			{ validUntil: '2026-09-10', costAfter: full },
			// Already past, and a date with no replacement price: neither can schedule anything.
			{ validUntil: '2026-09-01', costAfter: full },
			{ validUntil: '2026-09-09', costAfter: undefined },
		], now);
		assert.strictEqual(moment, Date.parse('2026-09-10T00:00:00Z'));
		assert.strictEqual(nextPriceChangeMoment([], now), undefined);
	});
});
