/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	checkBundleVersionSync,
	describeBundleVersionVerdict,
} from '../../common/i18nBundleVersionCheck.js';

suite('i18n bundle ↔ vibeVersion sync check — pure helper', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('checkBundleVersionSync', () => {
		test('exact match → in-sync', () => {
			const r = checkBundleVersionSync({ ideVersion: '1.2.3', bundleVersion: '1.2.3' });
			assert.strictEqual(r.kind, 'in-sync');
			if (r.kind === 'in-sync') { assert.strictEqual(r.version, '1.2.3'); }
		});

		test('whitespace trimmed before compare', () => {
			const r = checkBundleVersionSync({ ideVersion: '  1.2.3  ', bundleVersion: '1.2.3' });
			assert.strictEqual(r.kind, 'in-sync');
		});

		test('major drift', () => {
			const r = checkBundleVersionSync({ ideVersion: '2.0.0', bundleVersion: '1.0.0' });
			assert.strictEqual(r.kind, 'mismatch');
			if (r.kind === 'mismatch') { assert.strictEqual(r.drift, 'major'); }
		});

		test('minor drift', () => {
			const r = checkBundleVersionSync({ ideVersion: '1.5.0', bundleVersion: '1.4.0' });
			assert.strictEqual(r.kind, 'mismatch');
			if (r.kind === 'mismatch') { assert.strictEqual(r.drift, 'minor'); }
		});

		test('patch drift', () => {
			const r = checkBundleVersionSync({ ideVersion: '1.0.5', bundleVersion: '1.0.4' });
			assert.strictEqual(r.kind, 'mismatch');
			if (r.kind === 'mismatch') { assert.strictEqual(r.drift, 'patch'); }
		});

		test('major dominates minor and patch difference', () => {
			const r = checkBundleVersionSync({ ideVersion: '2.5.7', bundleVersion: '1.4.6' });
			assert.strictEqual(r.kind, 'mismatch');
			if (r.kind === 'mismatch') { assert.strictEqual(r.drift, 'major'); }
		});

		test('pre-release suffix allowed and ignored for drift', () => {
			const r = checkBundleVersionSync({ ideVersion: '1.0.0-beta.1', bundleVersion: '1.0.0' });
			assert.strictEqual(r.kind, 'mismatch');
			// numeric major.minor.patch identical → drift bucket = patch (else branch fallthrough)
			if (r.kind === 'mismatch') { assert.strictEqual(r.drift, 'patch'); }
		});

		test('unparseable strings → mismatch:unparseable', () => {
			const r = checkBundleVersionSync({ ideVersion: 'next', bundleVersion: '1.0.0' });
			assert.strictEqual(r.kind, 'mismatch');
			if (r.kind === 'mismatch') { assert.strictEqual(r.drift, 'unparseable'); }
		});

		test('undefined ide → invalid-input ide-missing', () => {
			const r = checkBundleVersionSync({ ideVersion: undefined, bundleVersion: '1.0.0' });
			assert.strictEqual(r.kind, 'invalid-input');
			if (r.kind === 'invalid-input') { assert.strictEqual(r.reason, 'ide-missing'); }
		});

		test('undefined bundle → invalid-input bundle-missing', () => {
			const r = checkBundleVersionSync({ ideVersion: '1.0.0', bundleVersion: undefined });
			assert.strictEqual(r.kind, 'invalid-input');
			if (r.kind === 'invalid-input') { assert.strictEqual(r.reason, 'bundle-missing'); }
		});

		test('non-string types rejected', () => {
			const a = checkBundleVersionSync({ ideVersion: 1, bundleVersion: '1.0.0' });
			assert.strictEqual(a.kind, 'invalid-input');
			if (a.kind === 'invalid-input') { assert.strictEqual(a.reason, 'ide-not-string'); }

			const b = checkBundleVersionSync({ ideVersion: '1.0.0', bundleVersion: { v: '1.0.0' } });
			assert.strictEqual(b.kind, 'invalid-input');
			if (b.kind === 'invalid-input') { assert.strictEqual(b.reason, 'bundle-not-string'); }
		});

		test('whitespace-only string → malformed', () => {
			const r = checkBundleVersionSync({ ideVersion: '   ', bundleVersion: '1.0.0' });
			assert.strictEqual(r.kind, 'invalid-input');
			if (r.kind === 'invalid-input') { assert.strictEqual(r.reason, 'ide-malformed'); }
		});
	});

	suite('describeBundleVersionVerdict', () => {
		test('in-sync body has version', () => {
			const body = describeBundleVersionVerdict({ kind: 'in-sync', version: '1.2.3' });
			assert.ok(body.includes('1.2.3'));
			assert.ok(body.includes('✅'));
		});

		test('mismatch body lists both versions and drift', () => {
			const body = describeBundleVersionVerdict({
				kind: 'mismatch',
				ideVersion: '1.2.3',
				bundleVersion: '1.2.2',
				drift: 'patch',
			});
			assert.ok(body.includes('1.2.3'));
			assert.ok(body.includes('1.2.2'));
			assert.ok(body.includes('patch'));
			assert.ok(body.includes('build-language-packs'));
			assert.ok(body.includes('❌'));
		});

		test('invalid-input body lists reason', () => {
			const body = describeBundleVersionVerdict({ kind: 'invalid-input', reason: 'ide-missing' });
			assert.ok(body.includes('ide-missing'));
		});
	});
});
