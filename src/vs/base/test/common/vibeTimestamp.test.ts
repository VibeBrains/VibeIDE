/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { strictEqual, match } from 'assert';
import { vibeTimestamp } from '../../common/vibeTimestamp.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from './utils.js';

// vibeTimestamp is the single source of the "DD.MM.YYYY HH:mm:ss" format shared by
// every VibeIDE log surface (renderer ConsoleLogger, the web-worker console wrapper,
// vibeTraceTs/vibeLog) — lock the format so a drift can't silently desync them.
suite('vibeTimestamp', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('default (now) matches DD.MM.YYYY HH:mm:ss', () => {
		match(vibeTimestamp(), /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}:\d{2}$/);
	});

	test('zero-pads single-digit day/month/hour/minute/second (local time)', () => {
		// Constructed and read in local time, so the assertion is TZ-independent.
		strictEqual(vibeTimestamp(new Date(2026, 0, 5, 9, 3, 7)), '05.01.2026 09:03:07');
	});

	test('two-digit components pass through', () => {
		strictEqual(vibeTimestamp(new Date(2026, 10, 28, 14, 32, 19)), '28.11.2026 14:32:19');
	});

	test('end-of-year boundary', () => {
		strictEqual(vibeTimestamp(new Date(2025, 11, 31, 23, 59, 59)), '31.12.2025 23:59:59');
	});

	test('leap-year Feb 29 at midnight', () => {
		strictEqual(vibeTimestamp(new Date(2024, 1, 29, 0, 0, 0)), '29.02.2024 00:00:00');
	});
});
