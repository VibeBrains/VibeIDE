/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideRunConfirm,
	decideRunConfirmBulk,
	describeConfirmReason,
	buildTrustEntryAfterApproval,
} from '../../common/projectCommandsTrustConfirm.js';
import { CommandTrustEntry } from '../../common/commandTrustRevoke.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function trust(id: string, hash = HASH_A): CommandTrustEntry {
	return { id, commandShapeHash: hash, trustedAtMs: 1_000_000 };
}

suite('Project Commands — first-run trust confirm decision', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideRunConfirm', () => {
		test('command.confirm=true → always-confirm wins over trust', () => {
			const r = decideRunConfirm({
				command: { id: 'a', confirm: true },
				currentHash: HASH_A,
				trustEntry: trust('a'),
			});
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'always-confirm' });
		});

		test('no trust entry → first-run', () => {
			const r = decideRunConfirm({
				command: { id: 'a' },
				currentHash: HASH_A,
				trustEntry: undefined,
			});
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'first-run' });
		});

		test('trust hash mismatch → shape-changed-since-trust', () => {
			const r = decideRunConfirm({
				command: { id: 'a' },
				currentHash: HASH_B,
				trustEntry: trust('a', HASH_A),
			});
			assert.deepStrictEqual(r, { kind: 'require-confirm', reason: 'shape-changed-since-trust' });
		});

		test('trust hash matches + no always-confirm → auto-allow', () => {
			const r = decideRunConfirm({
				command: { id: 'a', confirm: false },
				currentHash: HASH_A,
				trustEntry: trust('a', HASH_A),
			});
			assert.deepStrictEqual(r, { kind: 'auto-allow' });
		});

		test('confirm:undefined behaves like absent (trusts on hash match)', () => {
			const r = decideRunConfirm({
				command: { id: 'a' },
				currentHash: HASH_A,
				trustEntry: trust('a', HASH_A),
			});
			assert.deepStrictEqual(r, { kind: 'auto-allow' });
		});

		test('always-confirm precedes shape-changed when both apply', () => {
			const r = decideRunConfirm({
				command: { id: 'a', confirm: true },
				currentHash: HASH_B,
				trustEntry: trust('a', HASH_A),
			});
			assert.strictEqual(r.kind, 'require-confirm');
			if (r.kind === 'require-confirm') {
				assert.strictEqual(r.reason, 'always-confirm');
			}
		});
	});

	suite('decideRunConfirmBulk', () => {
		test('mix of first-run / auto-allow / always-confirm', () => {
			const r = decideRunConfirmBulk(
				[
					{ command: { id: 'first' }, currentHash: HASH_A },
					{ command: { id: 'trusted' }, currentHash: HASH_A },
					{ command: { id: 'forced', confirm: true }, currentHash: HASH_A },
				],
				[trust('trusted', HASH_A), trust('forced', HASH_A)],
			);
			assert.deepStrictEqual(r.map(x => x.decision.kind), ['require-confirm', 'auto-allow', 'require-confirm']);
			assert.strictEqual(r[0].decision.kind === 'require-confirm' && r[0].decision.reason, 'first-run');
			assert.strictEqual(r[2].decision.kind === 'require-confirm' && r[2].decision.reason, 'always-confirm');
		});

		test('preserves input order', () => {
			const r = decideRunConfirmBulk(
				[
					{ command: { id: 'b' }, currentHash: HASH_A },
					{ command: { id: 'a' }, currentHash: HASH_A },
				],
				[],
			);
			assert.deepStrictEqual(r.map(x => x.id), ['b', 'a']);
		});

		test('empty inputs', () => {
			assert.deepStrictEqual(decideRunConfirmBulk([], []), []);
		});
	});

	suite('describeConfirmReason', () => {
		test('first-run mentions name', () => {
			const s = describeConfirmReason('first-run', 'Build');
			assert.ok(s.includes('Build'));
			assert.ok(s.includes('впервые'));
		});

		test('shape-changed-since-trust', () => {
			const s = describeConfirmReason('shape-changed-since-trust', 'Build');
			assert.ok(s.includes('изменилась'));
		});

		test('always-confirm', () => {
			const s = describeConfirmReason('always-confirm', 'Build');
			assert.ok(s.includes('каждом запуске'));
		});
	});

	suite('buildTrustEntryAfterApproval', () => {
		test('produces a complete CommandTrustEntry', () => {
			const e = buildTrustEntryAfterApproval({ id: 'a' }, HASH_A, 12_345);
			assert.deepStrictEqual(e, {
				id: 'a',
				commandShapeHash: HASH_A,
				trustedAtMs: 12_345,
				lastUsedAtMs: 12_345,
			});
		});

		test('time injected — no Date.now coupling', () => {
			const e1 = buildTrustEntryAfterApproval({ id: 'a' }, HASH_A, 1);
			const e2 = buildTrustEntryAfterApproval({ id: 'a' }, HASH_A, 2);
			assert.strictEqual(e1.trustedAtMs, 1);
			assert.strictEqual(e2.trustedAtMs, 2);
		});
	});
});
