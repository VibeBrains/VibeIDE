/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideWindowRole,
	decodeWindowLock,
	buildWindowLock,
	refreshWindowLockHeartbeat,
	WindowLock,
} from '../../common/windowLockPolicy.js';

const NOW = 1_700_000_000_000;
const TTL = 60_000;

const lockAt = (overrides: Partial<WindowLock> = {}): WindowLock => ({
	pid: 1234,
	startedAtMs: NOW - 10_000,
	lastHeartbeatAtMs: NOW - 1_000,
	...overrides,
});

suite('windowLockPolicy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideWindowRole', () => {
		test('no lock → first-owner', () => {
			const r = decideWindowRole({ now: NOW, currentPid: 999, lock: null });
			assert.strictEqual(r.role, 'first-owner');
		});

		test('lock present with same pid → owner (pid-match)', () => {
			const r = decideWindowRole({ now: NOW, currentPid: 1234, lock: lockAt() });
			assert.strictEqual(r.role, 'owner');
			if (r.role === 'owner') { assert.strictEqual(r.reason, 'pid-match'); }
		});

		test('lock present with same windowId → owner (window-id-match) even if pid differs', () => {
			const r = decideWindowRole({
				now: NOW,
				currentPid: 9999,
				currentWindowId: 'w-1',
				lock: lockAt({ pid: 1234, windowId: 'w-1' }),
			});
			assert.strictEqual(r.role, 'owner');
			if (r.role === 'owner') { assert.strictEqual(r.reason, 'window-id-match'); }
		});

		test('foreign pid + fresh heartbeat → observer', () => {
			const r = decideWindowRole({
				now: NOW,
				currentPid: 9999,
				lock: lockAt({ pid: 1234, lastHeartbeatAtMs: NOW - 5_000 }),
			});
			assert.strictEqual(r.role, 'observer');
			if (r.role === 'observer') {
				assert.strictEqual(r.reason, 'foreign-lock-valid');
				assert.strictEqual(r.heartbeatAgeMs, 5_000);
			}
		});

		test('foreign pid + stale heartbeat → takeover-candidate', () => {
			const r = decideWindowRole({
				now: NOW,
				currentPid: 9999,
				ttlMs: TTL,
				lock: lockAt({ pid: 1234, lastHeartbeatAtMs: NOW - 70_000 }),
			});
			assert.strictEqual(r.role, 'takeover-candidate');
			if (r.role === 'takeover-candidate') {
				assert.strictEqual(r.reason, 'stale-heartbeat');
				assert.strictEqual(r.staleByMs, 10_000); // 70s age - 60s ttl
			}
		});

		test('foreign pid + isPidAlive returns false → takeover-candidate (pid-vanished) even on fresh heartbeat', () => {
			const r = decideWindowRole({
				now: NOW,
				currentPid: 9999,
				ttlMs: TTL,
				lock: lockAt({ pid: 4321, lastHeartbeatAtMs: NOW - 1_000 }),
				isPidAlive: () => false,
			});
			assert.strictEqual(r.role, 'takeover-candidate');
			if (r.role === 'takeover-candidate') { assert.strictEqual(r.reason, 'pid-vanished'); }
		});

		test('default ttl is 60s when not provided', () => {
			const r = decideWindowRole({
				now: NOW,
				currentPid: 9999,
				lock: lockAt({ lastHeartbeatAtMs: NOW - 59_999 }),
			});
			assert.strictEqual(r.role, 'observer');
		});

		test('windowId match wins over PID mismatch (same instance, restarted)', () => {
			// Process restart re-uses windowId from a sidecar but gets a new PID.
			const r = decideWindowRole({
				now: NOW,
				currentPid: 5000,
				currentWindowId: 'stable',
				lock: lockAt({ pid: 4000, windowId: 'stable', lastHeartbeatAtMs: NOW - 5_000 }),
			});
			assert.strictEqual(r.role, 'owner');
		});

		test('observer never returns negative heartbeatAge (clock skew clamp)', () => {
			const r = decideWindowRole({
				now: NOW,
				currentPid: 9999,
				lock: lockAt({ pid: 1234, lastHeartbeatAtMs: NOW + 5_000 }),
			});
			if (r.role === 'observer') { assert.strictEqual(r.heartbeatAgeMs, 0); }
		});
	});

	suite('decodeWindowLock', () => {
		test('valid object → decoded', () => {
			const r = decodeWindowLock({ pid: 1234, startedAtMs: 1, lastHeartbeatAtMs: 2 });
			assert.ok(r);
			assert.strictEqual(r!.pid, 1234);
		});

		test('valid object with windowId → decoded with id', () => {
			const r = decodeWindowLock({ pid: 1, startedAtMs: 1, lastHeartbeatAtMs: 2, windowId: 'abc' });
			assert.strictEqual(r?.windowId, 'abc');
		});

		test('null/undefined → null', () => {
			assert.strictEqual(decodeWindowLock(null), null);
			assert.strictEqual(decodeWindowLock(undefined), null);
		});

		test('non-object → null', () => {
			assert.strictEqual(decodeWindowLock('string'), null);
			assert.strictEqual(decodeWindowLock(42), null);
		});

		test('missing pid → null', () => {
			assert.strictEqual(decodeWindowLock({ startedAtMs: 1, lastHeartbeatAtMs: 2 }), null);
		});

		test('non-finite numbers → null', () => {
			assert.strictEqual(decodeWindowLock({ pid: NaN, startedAtMs: 1, lastHeartbeatAtMs: 2 }), null);
			assert.strictEqual(decodeWindowLock({ pid: 1, startedAtMs: Infinity, lastHeartbeatAtMs: 2 }), null);
		});

		test('zero or negative pid → null', () => {
			assert.strictEqual(decodeWindowLock({ pid: 0, startedAtMs: 1, lastHeartbeatAtMs: 2 }), null);
			assert.strictEqual(decodeWindowLock({ pid: -1, startedAtMs: 1, lastHeartbeatAtMs: 2 }), null);
		});

		test('empty windowId is dropped (treated as absent)', () => {
			const r = decodeWindowLock({ pid: 1, startedAtMs: 1, lastHeartbeatAtMs: 2, windowId: '' });
			assert.strictEqual(r?.windowId, undefined);
		});
	});

	suite('buildWindowLock / refreshWindowLockHeartbeat', () => {
		test('build sets identical timestamps and no windowId by default', () => {
			const r = buildWindowLock(1234, NOW);
			assert.strictEqual(r.pid, 1234);
			assert.strictEqual(r.startedAtMs, NOW);
			assert.strictEqual(r.lastHeartbeatAtMs, NOW);
			assert.strictEqual(r.windowId, undefined);
		});

		test('build includes windowId when provided', () => {
			const r = buildWindowLock(1234, NOW, 'inst-1');
			assert.strictEqual(r.windowId, 'inst-1');
		});

		test('refresh keeps identity, advances heartbeat only', () => {
			const prev = buildWindowLock(1234, NOW, 'inst-1');
			const next = refreshWindowLockHeartbeat(prev, NOW + 20_000);
			assert.strictEqual(next.pid, prev.pid);
			assert.strictEqual(next.startedAtMs, prev.startedAtMs);
			assert.strictEqual(next.windowId, 'inst-1');
			assert.strictEqual(next.lastHeartbeatAtMs, NOW + 20_000);
		});
	});
});
