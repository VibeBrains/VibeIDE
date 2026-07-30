/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	isQuotaLow,
	isQuotaStale,
	parseProviderQuotaHeaders,
	parseResetToUnixMs,
	pickRateLimitHeaders,
	QUOTA_STALE_MS,
	tightestBucket,
} from '../../common/providerQuota.js';

suite('providerQuota', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const NOW = 1_800_000_000_000; // fixed clock — the parser must never read the wall clock itself

	test('Anthropic headers become buckets with limits and reset times', () => {
		const snapshot = parseProviderQuotaHeaders({
			'anthropic-ratelimit-requests-remaining': '48',
			'anthropic-ratelimit-requests-limit': '50',
			'anthropic-ratelimit-requests-reset': '2027-01-15T10:30:00Z',
			'anthropic-ratelimit-input-tokens-remaining': '9000',
			'anthropic-ratelimit-input-tokens-limit': '20000',
		}, NOW);

		assert.deepStrictEqual(snapshot, {
			buckets: [
				{ kind: 'requests', remaining: 48, limit: 50, resetsAt: Date.parse('2027-01-15T10:30:00Z') },
				{ kind: 'input-tokens', remaining: 9000, limit: 20000 },
			],
			observedAt: NOW,
		});
	});

	test('OpenAI headers with duration resets', () => {
		const snapshot = parseProviderQuotaHeaders({
			'x-ratelimit-remaining-requests': '1',
			'x-ratelimit-limit-requests': '60',
			'x-ratelimit-reset-requests': '1m30s',
			'x-ratelimit-remaining-tokens': '12000',
			'x-ratelimit-limit-tokens': '150000',
			'x-ratelimit-reset-tokens': '6ms',
		}, NOW);

		assert.deepStrictEqual(snapshot, {
			buckets: [
				{ kind: 'requests', remaining: 1, limit: 60, resetsAt: NOW + 90_000 },
				{ kind: 'tokens', remaining: 12000, limit: 150000, resetsAt: NOW + 6 },
			],
			observedAt: NOW,
		});
	});

	test('vendor headers win over the generic ones a gateway may echo', () => {
		const snapshot = parseProviderQuotaHeaders({
			'anthropic-ratelimit-requests-remaining': '5',
			'ratelimit-remaining': '999',
		}, NOW);

		assert.deepStrictEqual(snapshot?.buckets, [{ kind: 'requests', remaining: 5 }]);
	});

	test('nothing usable reported → undefined, so the caller keeps the previous snapshot', () => {
		assert.strictEqual(parseProviderQuotaHeaders({ 'content-type': 'application/json' }, NOW), undefined);
	});

	test('retry-after alone is still a snapshot', () => {
		assert.deepStrictEqual(
			parseProviderQuotaHeaders({ 'retry-after': '30' }, NOW),
			{ buckets: [], retryAfterSec: 30, observedAt: NOW },
		);
	});

	test('reset shapes: seconds-from-now, epoch seconds, epoch ms, garbage', () => {
		assert.deepStrictEqual(
			[
				parseResetToUnixMs('30', NOW),
				parseResetToUnixMs('1800000123', NOW),
				parseResetToUnixMs('1800000123000', NOW),
				parseResetToUnixMs('soon', NOW),
				parseResetToUnixMs(undefined, NOW),
			],
			[NOW + 30_000, 1_800_000_123_000, 1_800_000_123_000, undefined, undefined],
		);
	});

	test('tightest bucket drives the warning; unlimited buckets only count when empty', () => {
		const snapshot = parseProviderQuotaHeaders({
			'anthropic-ratelimit-requests-remaining': '40',
			'anthropic-ratelimit-requests-limit': '50',
			'anthropic-ratelimit-tokens-remaining': '100',
			'anthropic-ratelimit-tokens-limit': '10000',
		}, NOW)!;

		assert.deepStrictEqual(tightestBucket(snapshot), { kind: 'tokens', remaining: 100, limit: 10000 });
		assert.strictEqual(isQuotaLow(snapshot, NOW), true);
	});

	test('comfortable remainder does not warn', () => {
		const snapshot = parseProviderQuotaHeaders({
			'x-ratelimit-remaining-requests': '55',
			'x-ratelimit-limit-requests': '60',
		}, NOW)!;

		assert.strictEqual(isQuotaLow(snapshot, NOW), false);
	});

	test('a bucket at zero warns even without a reported limit', () => {
		const snapshot = parseProviderQuotaHeaders({ 'ratelimit-remaining': '0' }, NOW)!;
		assert.strictEqual(isQuotaLow(snapshot, NOW), true);
	});

	test('stale snapshot stops warning — it says nothing about the current state', () => {
		const snapshot = parseProviderQuotaHeaders({ 'ratelimit-remaining': '0' }, NOW)!;
		const later = NOW + QUOTA_STALE_MS + 1;

		assert.deepStrictEqual(
			[isQuotaStale(snapshot, later), isQuotaLow(snapshot, later)],
			[true, false],
		);
	});

	test('diagnostics keep rate-limit headers — including vendor prefixes we do not know yet — and drop the rest', () => {
		const picked = pickRateLimitHeaders({
			'X-RateLimit-Remaining-Requests': '3',
			'Retry-After': '30',
			'x-minimax-ratelimit-window': '60',   // invented prefix: substring matching must still catch it
			'x-request-id': 'req_42',
			'set-cookie': 'session=secret',        // never logged: the log file gets shared
			'content-type': 'text/event-stream',
		});

		assert.deepStrictEqual(picked, {
			'x-ratelimit-remaining-requests': '3',
			'retry-after': '30',
			'x-minimax-ratelimit-window': '60',
			'x-request-id': 'req_42',
		});
	});

	test('nothing relevant reports nothing, rather than an empty object', () => {
		assert.deepStrictEqual(
			[pickRateLimitHeaders({ 'content-type': 'application/json' }), pickRateLimitHeaders(undefined)],
			[undefined, undefined],
		);
	});
});
