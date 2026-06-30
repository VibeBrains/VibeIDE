/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideTrustRevocations,
	decodeCommandTrustEntries,
	buildTrustRevokeAuditEntries,
	CommandTrustEntry,
	CommandShape,
} from '../../common/commandTrustRevoke.js';

const NOW = 1_700_000_000_000;

const trust = (id: string, hash: string, lastUsed?: number): CommandTrustEntry => ({
	id, commandShapeHash: hash, trustedAtMs: NOW - 86_400_000,
	...(lastUsed !== undefined ? { lastUsedAtMs: lastUsed } : {}),
});

const cmd = (id: string, hash: string): CommandShape => ({ id, commandShapeHash: hash });

suite('commandTrustRevoke', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideTrustRevocations', () => {
		test('explicit revocation wins over shape match', () => {
			const r = decideTrustRevocations({
				trust: [trust('build', 'h1')],
				commands: [cmd('build', 'h1')],
				explicitlyRevokedId: 'build',
			});
			assert.strictEqual(r.keep.length, 0);
			assert.strictEqual(r.revoke[0].reason, 'explicit');
		});

		test('orphaned id (in trust, not in commands) → revoke', () => {
			const r = decideTrustRevocations({
				trust: [trust('deleted', 'h1')],
				commands: [],
			});
			assert.strictEqual(r.revoke[0].reason, 'orphaned');
			assert.strictEqual(r.revoke[0].newHash, undefined);
		});

		test('shape-changed → revoke with both hashes', () => {
			const r = decideTrustRevocations({
				trust: [trust('build', 'old')],
				commands: [cmd('build', 'new')],
			});
			assert.strictEqual(r.revoke[0].reason, 'shape-changed');
			assert.strictEqual(r.revoke[0].oldHash, 'old');
			assert.strictEqual(r.revoke[0].newHash, 'new');
		});

		test('matching id + hash → keep', () => {
			const r = decideTrustRevocations({
				trust: [trust('build', 'h1')],
				commands: [cmd('build', 'h1')],
			});
			assert.strictEqual(r.keep.length, 1);
			assert.strictEqual(r.revoke.length, 0);
		});

		test('explicit on orphaned id → reason still "explicit" (rule-1 wins)', () => {
			const r = decideTrustRevocations({
				trust: [trust('gone', 'h1')],
				commands: [],
				explicitlyRevokedId: 'gone',
			});
			assert.strictEqual(r.revoke[0].reason, 'explicit');
		});

		test('mixed batch partitions correctly', () => {
			const r = decideTrustRevocations({
				trust: [
					trust('build', 'h1'),     // keep
					trust('test', 'old'),     // shape-changed
					trust('lint', 'h3'),      // explicit
					trust('deleted', 'h4'),   // orphaned
				],
				commands: [
					cmd('build', 'h1'),
					cmd('test', 'new'),
					cmd('lint', 'h3'),
				],
				explicitlyRevokedId: 'lint',
			});
			assert.strictEqual(r.keep.length, 1);
			assert.strictEqual(r.revoke.length, 3);
			const reasons = r.revoke.map(d => d.reason).sort();
			assert.deepStrictEqual(reasons, ['explicit', 'orphaned', 'shape-changed']);
		});

		test('empty input → empty output', () => {
			const r = decideTrustRevocations({ trust: [], commands: [] });
			assert.strictEqual(r.keep.length, 0);
			assert.strictEqual(r.revoke.length, 0);
		});

		test('lastUsedAtMs preserved on keep', () => {
			const r = decideTrustRevocations({
				trust: [trust('build', 'h1', NOW - 3600_000)],
				commands: [cmd('build', 'h1')],
			});
			assert.strictEqual(r.keep[0].lastUsedAtMs, NOW - 3600_000);
		});
	});

	suite('decodeCommandTrustEntries', () => {
		test('valid array → decoded', () => {
			const r = decodeCommandTrustEntries([
				{ id: 'a', commandShapeHash: 'h', trustedAtMs: 1, lastUsedAtMs: 2 },
				{ id: 'b', commandShapeHash: 'h2', trustedAtMs: 3 },
			]);
			assert.strictEqual(r?.length, 2);
			assert.strictEqual(r?.[0].lastUsedAtMs, 2);
			assert.strictEqual(r?.[1].lastUsedAtMs, undefined);
		});

		test('non-array → null', () => {
			assert.strictEqual(decodeCommandTrustEntries({}), null);
			assert.strictEqual(decodeCommandTrustEntries(null), null);
		});

		test('any malformed entry rejects whole document', () => {
			assert.strictEqual(decodeCommandTrustEntries([
				{ id: 'a', commandShapeHash: 'h', trustedAtMs: 1 },
				{ id: '', commandShapeHash: 'h', trustedAtMs: 2 },
			]), null);
		});

		test('NaN/Infinity in timestamps rejects', () => {
			assert.strictEqual(decodeCommandTrustEntries([
				{ id: 'a', commandShapeHash: 'h', trustedAtMs: NaN },
			]), null);
			assert.strictEqual(decodeCommandTrustEntries([
				{ id: 'a', commandShapeHash: 'h', trustedAtMs: 1, lastUsedAtMs: Infinity },
			])?.[0].lastUsedAtMs, undefined);
		});

		test('empty hash rejects', () => {
			assert.strictEqual(decodeCommandTrustEntries([
				{ id: 'a', commandShapeHash: '', trustedAtMs: 1 },
			]), null);
		});
	});

	suite('buildTrustRevokeAuditEntries', () => {
		test('reduces to id + reason + hash prefixes (8 chars)', () => {
			const result = decideTrustRevocations({
				trust: [trust('build', 'abcdef0123456789')],
				commands: [cmd('build', '0123456789abcdef')],
			});
			const audit = buildTrustRevokeAuditEntries(result);
			assert.strictEqual(audit[0].oldHashPrefix, 'abcdef01');
			assert.strictEqual(audit[0].newHashPrefix, '01234567');
		});

		test('orphaned drops newHashPrefix', () => {
			const result = decideTrustRevocations({
				trust: [trust('gone', 'abcdef0123456789')],
				commands: [],
			});
			const audit = buildTrustRevokeAuditEntries(result);
			assert.strictEqual(audit[0].newHashPrefix, undefined);
		});

		test('explicit drops newHashPrefix even when shape exists', () => {
			const result = decideTrustRevocations({
				trust: [trust('build', 'abcdef0123456789')],
				commands: [cmd('build', '0123456789abcdef')],
				explicitlyRevokedId: 'build',
			});
			const audit = buildTrustRevokeAuditEntries(result);
			assert.strictEqual(audit[0].newHashPrefix, undefined);
		});
	});
});
