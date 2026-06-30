/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	filterLocksForDisposal,
	buildLockReleaseAuditEntries,
	decodeAgentLocks,
	parseIsoMs,
	AgentLockEntry,
} from '../../common/agentLockDisposal.js';

const NOW = Date.parse('2026-05-08T12:00:00Z');
const FUTURE = '2026-05-08T13:00:00Z';
const PAST = '2026-05-08T11:00:00Z';

const lock = (holder: string, paths: string[], until: string, reason?: string): AgentLockEntry => ({
	holder, paths, until, ...(reason ? { reason } : {}),
});

suite('agentLockDisposal', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('filterLocksForDisposal', () => {
		test('disposed holder → released (reason: holder-disposed)', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('s1', ['src/**'], FUTURE)],
				disposedHolders: new Set(['s1']),
			});
			assert.strictEqual(r.keep.length, 0);
			assert.strictEqual(r.release.length, 1);
			assert.strictEqual(r.release[0].reason, 'holder-disposed');
		});

		test('TTL-expired lock → released even if holder is alive', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('s1', ['src/**'], PAST)],
				disposedHolders: new Set(),
				livingHolders: new Set(['s1']),
			});
			assert.strictEqual(r.release.length, 1);
			assert.strictEqual(r.release[0].reason, 'ttl-expired');
		});

		test('unknown holder + livingHolders provided → released', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('ghost', ['src/**'], FUTURE)],
				disposedHolders: new Set(),
				livingHolders: new Set(['s1', 's2']),
			});
			assert.strictEqual(r.release.length, 1);
			assert.strictEqual(r.release[0].reason, 'unknown-holder');
		});

		test('unknown holder + livingHolders NOT provided → kept (cannot decide)', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('ghost', ['src/**'], FUTURE)],
				disposedHolders: new Set(),
			});
			assert.strictEqual(r.keep.length, 1);
		});

		test('disposed wins over TTL — disposed reason takes priority', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('s1', ['src/**'], PAST)],
				disposedHolders: new Set(['s1']),
			});
			assert.strictEqual(r.release[0].reason, 'holder-disposed');
		});

		test('living holder + future TTL → kept', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('s1', ['src/**'], FUTURE)],
				disposedHolders: new Set(),
				livingHolders: new Set(['s1']),
			});
			assert.strictEqual(r.keep.length, 1);
		});

		test('multiple locks partition correctly', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [
					lock('s1', ['a/**'], FUTURE),       // keep
					lock('s2', ['b/**'], FUTURE),       // disposed
					lock('s3', ['c/**'], PAST),         // ttl-expired
					lock('ghost', ['d/**'], FUTURE),    // unknown holder
				],
				disposedHolders: new Set(['s2']),
				livingHolders: new Set(['s1']),
			});
			assert.strictEqual(r.keep.length, 1);
			assert.strictEqual(r.release.length, 3);
			const reasons = r.release.map(d => d.reason).sort();
			assert.deepStrictEqual(reasons, ['holder-disposed', 'ttl-expired', 'unknown-holder']);
		});

		test('malformed until kept silently (vibe doctor surfaces)', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('s1', ['src/**'], 'not-an-iso-string')],
				disposedHolders: new Set(),
				livingHolders: new Set(['s1']),
			});
			assert.strictEqual(r.keep.length, 1);
		});

		test('empty input → empty output', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [],
				disposedHolders: new Set(),
			});
			assert.strictEqual(r.keep.length, 0);
			assert.strictEqual(r.release.length, 0);
		});
	});

	suite('buildLockReleaseAuditEntries', () => {
		test('reduces release entries to audit-friendly shape (no reason field of original entry)', () => {
			const r = filterLocksForDisposal({
				now: NOW,
				locks: [lock('s1', ['src/**'], FUTURE, 'edit:writeFile-secrets')],
				disposedHolders: new Set(['s1']),
			});
			const audit = buildLockReleaseAuditEntries(r);
			assert.strictEqual(audit.length, 1);
			assert.strictEqual(audit[0].holder, 's1');
			assert.deepStrictEqual(audit[0].paths, ['src/**']);
			assert.strictEqual(audit[0].reason, 'holder-disposed');
			// original entry's `reason` field NOT included (could leak path-style secrets)
			assert.ok(!Object.hasOwn(audit[0], 'originalReason'));
		});
	});

	suite('decodeAgentLocks', () => {
		test('valid array → typed', () => {
			const r = decodeAgentLocks([
				{ holder: 's1', paths: ['a'], until: FUTURE },
				{ holder: 's2', paths: ['b', 'c'], until: PAST, reason: 'edit' },
			]);
			assert.strictEqual(r?.length, 2);
			assert.strictEqual(r?.[1].reason, 'edit');
		});

		test('non-array → null', () => {
			assert.strictEqual(decodeAgentLocks({}), null);
			assert.strictEqual(decodeAgentLocks(null), null);
			assert.strictEqual(decodeAgentLocks('foo'), null);
		});

		test('any malformed entry rejects the whole document', () => {
			assert.strictEqual(decodeAgentLocks([
				{ holder: 's1', paths: ['a'], until: FUTURE },
				{ holder: '', paths: ['b'], until: PAST },  // empty holder
			]), null);
		});

		test('paths must be array of strings', () => {
			assert.strictEqual(decodeAgentLocks([
				{ holder: 's1', paths: ['a', 42], until: FUTURE },
			]), null);
		});

		test('empty reason is dropped (treated as absent)', () => {
			const r = decodeAgentLocks([
				{ holder: 's1', paths: ['a'], until: FUTURE, reason: '' },
			]);
			assert.strictEqual(r?.[0].reason, undefined);
		});
	});

	suite('parseIsoMs', () => {
		test('valid ISO → ms', () => {
			assert.strictEqual(parseIsoMs('2026-05-08T12:00:00Z'), NOW);
		});

		test('invalid → null', () => {
			assert.strictEqual(parseIsoMs('not iso'), null);
			assert.strictEqual(parseIsoMs(''), null);
		});

		test('non-string → null', () => {
			assert.strictEqual(parseIsoMs(null as unknown as string), null);
			assert.strictEqual(parseIsoMs(undefined as unknown as string), null);
		});
	});
});
