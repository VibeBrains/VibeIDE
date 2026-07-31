/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ProviderRequestRateWindow, REQUEST_RATE_WINDOW_MS } from '../../common/providerRequestRate.js';

suite('providerRequestRate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = 1_800_000_000_000; // fixed clock — the window must never read the wall clock itself

	test('counts requests inside the window and forgets the ones that aged out', () => {
		const window = new ProviderRequestRateWindow();

		const counts = [
			window.record('minimax', NOW),
			window.record('minimax', NOW + 1_000),
			window.record('minimax', NOW + 2_000),
			// The first three are now older than the window; only this one remains.
			window.record('minimax', NOW + REQUEST_RATE_WINDOW_MS + 3_000),
		];

		assert.deepStrictEqual(counts, [1, 2, 3, 1]);
	});

	test('providers are counted separately — one key running hot must not implicate another', () => {
		const window = new ProviderRequestRateWindow();
		window.record('minimax', NOW);
		window.record('minimax', NOW);
		window.record('anthropic', NOW);

		assert.deepStrictEqual(
			{ minimax: window.countIn('minimax', NOW), anthropic: window.countIn('anthropic', NOW), unseen: window.countIn('openai', NOW) },
			{ minimax: 2, anthropic: 1, unseen: 0 },
		);
	});

	test('a stamp exactly at the window edge has expired', () => {
		const window = new ProviderRequestRateWindow();
		window.record('minimax', NOW);

		assert.deepStrictEqual(
			{ atEdge: window.countIn('minimax', NOW + REQUEST_RATE_WINDOW_MS), justInside: window.countIn('minimax', NOW) },
			// Reading at the edge drops it; the second read confirms it did not come back.
			{ atEdge: 0, justInside: 0 },
		);
	});

	test('reports the window it measures, so a log line can state the unit', () => {
		assert.deepStrictEqual(
			{ standard: new ProviderRequestRateWindow().windowSeconds, custom: new ProviderRequestRateWindow(5_000).windowSeconds },
			{ standard: 60, custom: 5 },
		);
	});

	test('retention is capped so a runaway loop cannot grow the window unboundedly', () => {
		const window = new ProviderRequestRateWindow();
		for (let i = 0; i < 1_500; i++) { window.record('minimax', NOW + i); }

		assert.strictEqual(window.countIn('minimax', NOW + 1_500), 1_000);
	});
});
