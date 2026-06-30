/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decodePackEnvelope,
	verifyPackHashes,
	SkillCommunityPackEnvelope,
} from '../../common/skillPackVerifier.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const sha = (c: string) => c.repeat(64);

const validEnvelope = (overrides: Partial<SkillCommunityPackEnvelope> = {}): SkillCommunityPackEnvelope => ({
	formatVersion: 'vibe-community-skills-catalog-v1',
	publishedAt: 1_750_000_000_000,
	entries: [{ id: 'a', name: 'A', content: 'hello' }],
	manifestSha256: { a: sha('1') },
	...overrides,
});

suite('Community skill-pack verifier', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodePackEnvelope', () => {
		test('happy path', () => {
			const r = decodePackEnvelope(validEnvelope());
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.entries.length, 1); }
		});

		test('rejects unknown formatVersion', () => {
			const r = decodePackEnvelope({ ...validEnvelope(), formatVersion: 'oops' });
			assert.deepStrictEqual(r, { ok: false, reason: 'formatVersion-unknown' });
		});

		test('rejects malformed entries[i].id', () => {
			const r = decodePackEnvelope({
				...validEnvelope(),
				entries: [{ id: 'BAD ID', name: 'x', content: 'y' }],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'entries[0]:id-invalid'); }
		});

		test('rejects empty content', () => {
			const r = decodePackEnvelope({
				...validEnvelope(),
				entries: [{ id: 'a', name: 'x', content: '' }],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'entries[0]:content-missing'); }
		});

		test('rejects duplicate id', () => {
			const r = decodePackEnvelope({
				...validEnvelope(),
				entries: [
					{ id: 'a', name: 'X', content: 'foo' },
					{ id: 'a', name: 'Y', content: 'bar' },
				],
				manifestSha256: { a: sha('1') },
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.match(r.reason, /^entries\[1\]:duplicate-id:a$/); }
		});

		test('rejects malformed sha256 in manifest', () => {
			const r = decodePackEnvelope({
				...validEnvelope(),
				manifestSha256: { a: 'too-short' },
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.match(r.reason, /manifestSha256\.a:invalid-sha256/); }
		});

		test('lowercases sha256 in output', () => {
			const r = decodePackEnvelope({ ...validEnvelope(), manifestSha256: { a: 'A'.repeat(64) } });
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.manifestSha256.a, 'a'.repeat(64)); }
		});
	});

	suite('verifyPackHashes', () => {
		test('matching computed hashes → ok', () => {
			const env = validEnvelope();
			const r = verifyPackHashes(env, [{ id: 'a', sha256: sha('1') }]);
			assert.strictEqual(r.ok, true);
		});

		test('mismatched hash → sha-mismatch', () => {
			const env = validEnvelope();
			const r = verifyPackHashes(env, [{ id: 'a', sha256: sha('2') }]);
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.strictEqual(r.reason, 'sha-mismatch');
				assert.match(r.details!, /^a: expected=/);
			}
		});

		test('missing entry in computed → manifest-incomplete', () => {
			const env = validEnvelope({
				entries: [{ id: 'a', name: 'A', content: 'x' }, { id: 'b', name: 'B', content: 'y' }],
				manifestSha256: { a: sha('1'), b: sha('2') },
			});
			const r = verifyPackHashes(env, [{ id: 'a', sha256: sha('1') }]);
			assert.strictEqual(r.ok, false);
			if (!r.ok) {
				assert.strictEqual(r.reason, 'manifest-incomplete');
				assert.strictEqual(r.details, 'b');
			}
		});

		test('missing entry in manifest → manifest-incomplete', () => {
			const env = validEnvelope({
				entries: [{ id: 'a', name: 'A', content: 'x' }, { id: 'b', name: 'B', content: 'y' }],
				manifestSha256: { a: sha('1') /* no 'b' */ },
			});
			const r = verifyPackHashes(env, [
				{ id: 'a', sha256: sha('1') },
				{ id: 'b', sha256: sha('2') },
			]);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'manifest-incomplete'); }
		});

		test('duplicate id in computed → duplicate-id', () => {
			const env = validEnvelope();
			const r = verifyPackHashes(env, [
				{ id: 'a', sha256: sha('1') },
				{ id: 'a', sha256: sha('2') },
			]);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'duplicate-id'); }
		});

		test('case-insensitive sha comparison', () => {
			const env = validEnvelope({ manifestSha256: { a: 'A'.repeat(64) } });
			// Decoder lowercases manifest. Computed hash with mixed case still matches.
			const decoded = decodePackEnvelope(env);
			assert.strictEqual(decoded.ok, true);
			if (decoded.ok) {
				const r = verifyPackHashes(decoded.value, [{ id: 'a', sha256: 'a'.repeat(64).toUpperCase() }]);
				assert.strictEqual(r.ok, true);
			}
		});
	});
});
