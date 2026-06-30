/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Tests for `computeSamplingIntervalMs` (roadmap W.50 adaptive + 1630 burst).
 *
 * Pure decision function for the idle-watchdog sampling cadence. A regression here
 * silently breaks the burst speed-up that exists to catch sub-60s memory spikes
 * (OOM incidents #008 / 2026-05-27 / 2026-05-30), or the adaptive idle stretch.
 */

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	ADAPTIVE_IDLE_THRESHOLD_SEC,
	ADAPTIVE_RATE_MULTIPLIER,
	computeSamplingIntervalMs,
} from '../../common/vibeIdleWatchdogSampling.js';

const MIN = 60 * 1000;

suite('Idle Watchdog — sampling interval (W.50 / 1630)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('base interval when neither burst nor adaptive', () => {
		const ms = computeSamplingIntervalMs({ burstTicksRemaining: 0, burstSeconds: 15, adaptive: false, intervalMinutes: 5, idleMs: 10 * 60 * 60 * 1000 });
		assert.strictEqual(ms, 5 * MIN);
	});

	test('adaptive stretches the interval when idle beyond threshold', () => {
		const idleMs = (ADAPTIVE_IDLE_THRESHOLD_SEC + 1) * 1000;
		const ms = computeSamplingIntervalMs({ burstTicksRemaining: 0, burstSeconds: 15, adaptive: true, intervalMinutes: 5, idleMs });
		assert.strictEqual(ms, 5 * MIN * ADAPTIVE_RATE_MULTIPLIER);
	});

	test('adaptive does NOT stretch while still active (idle below threshold)', () => {
		const idleMs = (ADAPTIVE_IDLE_THRESHOLD_SEC - 1) * 1000;
		const ms = computeSamplingIntervalMs({ burstTicksRemaining: 0, burstSeconds: 15, adaptive: true, intervalMinutes: 5, idleMs });
		assert.strictEqual(ms, 5 * MIN);
	});

	test('burst takes precedence over base', () => {
		const ms = computeSamplingIntervalMs({ burstTicksRemaining: 3, burstSeconds: 15, adaptive: false, intervalMinutes: 5, idleMs: 0 });
		assert.strictEqual(ms, 15 * 1000);
	});

	test('burst overrides adaptive stretch (a leak in progress beats idleness)', () => {
		const idleMs = (ADAPTIVE_IDLE_THRESHOLD_SEC + 999) * 1000; // would stretch if not bursting
		const ms = computeSamplingIntervalMs({ burstTicksRemaining: 12, burstSeconds: 20, adaptive: true, intervalMinutes: 5, idleMs });
		assert.strictEqual(ms, 20 * 1000);
	});

	test('burst ends exactly at 0 remaining ticks (falls back to base)', () => {
		const ms = computeSamplingIntervalMs({ burstTicksRemaining: 0, burstSeconds: 15, adaptive: false, intervalMinutes: 5, idleMs: 0 });
		assert.strictEqual(ms, 5 * MIN);
	});
});
