/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	parseDigestTime,
	lastDueMs,
	msUntilNextDue,
	isCatchUpDue,
	digestPeriod,
} from '../../common/agentDigestSchedule.js';

/** Local-time helper — the schedule is deliberately local-clock, so tests must be too. */
function at(y: number, m: number, d: number, hh: number, mm: number, ss = 0): number {
	return new Date(y, m - 1, d, hh, mm, ss, 0).getTime();
}

suite('agentDigestSchedule', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseDigestTime accepts HH:MM and rejects anything else', () => {
		assert.deepStrictEqual(
			['09:00', '9:05', '23:59', '00:00', ' 07:30 ', '24:00', '09:60', '0900', 'утро', '', undefined]
				.map(v => parseDigestTime(v as string)),
			[540, 545, 1439, 0, 450, undefined, undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('lastDueMs — before the slot returns yesterday, after it returns today', () => {
		const nine = 9 * 60;
		assert.strictEqual(lastDueMs(at(2026, 8, 12, 8, 30), nine), at(2026, 8, 11, 9, 0));
		assert.strictEqual(lastDueMs(at(2026, 8, 12, 9, 0), nine), at(2026, 8, 12, 9, 0));
		assert.strictEqual(lastDueMs(at(2026, 8, 12, 23, 59), nine), at(2026, 8, 12, 9, 0));
	});

	test('msUntilNextDue wraps past midnight and lands on the top of the minute', () => {
		// 23:30 → 09:00 next day is 9.5h; the stray 40s must be subtracted, not ignored.
		assert.strictEqual(
			msUntilNextDue(at(2026, 8, 12, 23, 30, 40), 9 * 60),
			9.5 * 60 * 60_000 - 40_000,
		);
		// Exactly at the slot → next firing is a full day away, never 0 (a 0-delay timer spins).
		assert.strictEqual(msUntilNextDue(at(2026, 8, 12, 9, 0), 9 * 60), 24 * 60 * 60_000);
	});

	test('never-sent does not trigger a catch-up, a missed slot does', () => {
		const nine = 9 * 60;
		const now = at(2026, 8, 12, 11, 0);
		assert.strictEqual(isCatchUpDue(now, nine, undefined), false, 'first ever run must stay quiet');
		assert.strictEqual(isCatchUpDue(now, nine, at(2026, 8, 11, 9, 0)), true, 'yesterday delivery, today missed');
		assert.strictEqual(isCatchUpDue(now, nine, at(2026, 8, 12, 9, 0)), false, 'already delivered today');
	});

	test('a late digest covers everything since the last delivery, not a fixed day', () => {
		const nine = 9 * 60;
		const now = at(2026, 8, 12, 11, 0);
		// Two days off → the window stretches to two days rather than losing the older day.
		assert.deepStrictEqual(
			digestPeriod(now, nine, at(2026, 8, 10, 9, 0)),
			{ fromMs: at(2026, 8, 10, 9, 0), toMs: now },
		);
		// Never delivered → the previous slot, so the first report is one day, not all of history.
		assert.deepStrictEqual(
			digestPeriod(now, nine, undefined),
			{ fromMs: at(2026, 8, 11, 9, 0), toMs: now },
		);
	});
});
