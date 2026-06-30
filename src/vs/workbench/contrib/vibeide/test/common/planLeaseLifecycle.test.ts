/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	isLeaseStale,
	partitionLeases,
	selectAllForEmergencyStop,
	decodeLease,
	PLAN_EXECUTION_LEASE_STALE_AFTER_MS,
	PlanExecutionLease,
} from '../../common/planLeaseLifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const lease = (planId: string, lastHeartbeat: number, threadId: string = 't1'): PlanExecutionLease => ({
	planId,
	threadId,
	holderNonce: 'n',
	startedAt: lastHeartbeat,
	lastHeartbeat,
});

const NOW = 1_750_000_000_000;
const STALE = PLAN_EXECUTION_LEASE_STALE_AFTER_MS;

suite('Plan lease lifecycle — pure helpers (K.1 / 904, 907)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('isLeaseStale', () => {
		test('undefined lease is stale (no holder)', () => {
			assert.strictEqual(isLeaseStale(undefined, NOW), true);
		});

		test('fresh lease is not stale', () => {
			assert.strictEqual(isLeaseStale(lease('p', NOW - 1000), NOW), false);
		});

		test('lease at exact boundary is not stale', () => {
			assert.strictEqual(isLeaseStale(lease('p', NOW - STALE), NOW), false);
		});

		test('lease past TTL is stale', () => {
			assert.strictEqual(isLeaseStale(lease('p', NOW - STALE - 1), NOW), true);
		});

		test('custom TTL respected', () => {
			assert.strictEqual(isLeaseStale(lease('p', NOW - 30_000), NOW, 60_000), false);
			assert.strictEqual(isLeaseStale(lease('p', NOW - 90_000), NOW, 60_000), true);
		});
	});

	suite('partitionLeases', () => {
		test('empty input → empty buckets', () => {
			assert.deepStrictEqual(partitionLeases([], NOW), { stale: [], live: [] });
		});

		test('mixed leases split correctly', () => {
			const fresh1 = lease('a', NOW - 1000);
			const fresh2 = lease('b', NOW - STALE + 100);
			const stale1 = lease('c', NOW - STALE - 1);
			const stale2 = lease('d', 0);
			const result = partitionLeases([fresh1, fresh2, stale1, stale2], NOW);
			assert.deepStrictEqual(result.live.map(l => l.planId), ['a', 'b']);
			assert.deepStrictEqual(result.stale.map(l => l.planId), ['c', 'd']);
		});

		test('preserves input order within each bucket', () => {
			const a = lease('a', NOW - 1);
			const b = lease('b', NOW - 2);
			const result = partitionLeases([a, b], NOW);
			assert.deepStrictEqual(result.live.map(l => l.planId), ['a', 'b']);
		});
	});

	suite('selectAllForEmergencyStop', () => {
		test('returns a copy of every input lease', () => {
			const input = [lease('a', NOW), lease('b', NOW - 100_000_000)];
			const out = selectAllForEmergencyStop(input);
			assert.strictEqual(out.length, 2);
			assert.notStrictEqual(out, input); // copy, not the same array
			assert.deepStrictEqual(out.map(l => l.planId), ['a', 'b']);
		});
	});

	suite('decodeLease', () => {
		test('happy path round-trips required fields', () => {
			const r = decodeLease({
				planId: 'p1', threadId: 't1', holderNonce: 'n1',
				startedAt: NOW, lastHeartbeat: NOW + 1000,
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.planId, 'p1');
				assert.strictEqual(r.value.lastHeartbeat, NOW + 1000);
			}
		});

		test('optional windowId carries through when finite', () => {
			const r = decodeLease({
				planId: 'p1', threadId: 't1', holderNonce: 'n1',
				startedAt: NOW, lastHeartbeat: NOW, windowId: 42,
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.windowId, 42); }
		});

		test('drops windowId when not finite', () => {
			const r = decodeLease({
				planId: 'p1', threadId: 't1', holderNonce: 'n1',
				startedAt: NOW, lastHeartbeat: NOW, windowId: 'oops',
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.windowId, undefined); }
		});

		test('rejects non-object', () => {
			assert.deepStrictEqual(decodeLease(null), { ok: false, reason: 'not-an-object' });
			assert.deepStrictEqual(decodeLease(42), { ok: false, reason: 'not-an-object' });
		});

		test('rejects when required field missing', () => {
			assert.deepStrictEqual(decodeLease({ threadId: 't', holderNonce: 'n', startedAt: 0, lastHeartbeat: 0 }), { ok: false, reason: 'planId-missing' });
		});

		test('rejects when timestamp not finite', () => {
			const r = decodeLease({
				planId: 'p', threadId: 't', holderNonce: 'n',
				startedAt: 0, lastHeartbeat: NaN,
			});
			assert.deepStrictEqual(r, { ok: false, reason: 'lastHeartbeat-invalid' });
		});
	});
});
