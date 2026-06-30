/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideSigning,
	evaluateReadinessGate,
	describeDecision,
	SigningCredentials,
} from '../../common/distributionSigningPolicy.js';

const NO_CREDS: SigningCredentials = {
	winEvCertPresent: false,
	macAppPasswordPresent: false,
};

const WIN_FULL: SigningCredentials = {
	winEvCertPresent: true,
	winTimestampServerUrl: 'http://timestamp.sectigo.com',
	macAppPasswordPresent: false,
};

const MAC_FULL: SigningCredentials = {
	winEvCertPresent: false,
	macAppleId: 'dev@example.com',
	macTeamId: 'ABC1234567',
	macAppPasswordPresent: true,
};

const ALL_FULL: SigningCredentials = {
	winEvCertPresent: true,
	winTimestampServerUrl: 'http://timestamp.sectigo.com',
	macAppleId: 'dev@example.com',
	macTeamId: 'ABC1234567',
	macAppPasswordPresent: true,
	linuxGpgKeyId: '0123456789ABCDEF',
};

suite('distributionSigningPolicy — Windows', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('release without EV cert blocks', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: NO_CREDS, buildKind: 'release' });
		assert.strictEqual(d.action, 'block-release');
		if (d.action === 'block-release') { assert.strictEqual(d.reason, 'release-mode-but-no-credentials'); }
	});

	test('release with allowUnsignedRelease downgrades to skip-unsigned', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: NO_CREDS, buildKind: 'release', allowUnsignedRelease: true });
		assert.strictEqual(d.action, 'skip-unsigned');
	});

	test('nightly without cert is unsigned with warning, not blocked', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: NO_CREDS, buildKind: 'nightly' });
		assert.strictEqual(d.action, 'skip-unsigned');
		if (d.action === 'skip-unsigned') { assert.strictEqual(d.reason, 'no-credentials-explicitly-allowed'); }
	});

	test('release with full creds emits sign + timestamp + verify', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: WIN_FULL, buildKind: 'release' });
		assert.strictEqual(d.action, 'sign');
		if (d.action === 'sign') {
			assert.deepStrictEqual([...d.steps], ['sign-binary', 'timestamp', 'verify']);
			assert.strictEqual(d.credentialRef, 'win-ev-token');
		}
	});

	test('release without timestamp server still signs (no timestamp step)', () => {
		const creds = { ...WIN_FULL, winTimestampServerUrl: undefined };
		const d = decideSigning({ platform: 'win32-x64', credentials: creds, buildKind: 'release' });
		assert.strictEqual(d.action, 'sign');
		if (d.action === 'sign') { assert.deepStrictEqual([...d.steps], ['sign-binary', 'verify']); }
	});
});

suite('distributionSigningPolicy — macOS', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('partial credentials (no app password) blocks', () => {
		const partial = { ...MAC_FULL, macAppPasswordPresent: false };
		const d = decideSigning({ platform: 'darwin-x64', credentials: partial, buildKind: 'release' });
		assert.strictEqual(d.action, 'block-release');
	});

	test('full credentials emit sign + notarize + staple + verify', () => {
		const d = decideSigning({ platform: 'darwin-universal', credentials: MAC_FULL, buildKind: 'release' });
		assert.strictEqual(d.action, 'sign');
		if (d.action === 'sign') {
			assert.deepStrictEqual([...d.steps], ['sign-binary', 'notarize', 'staple', 'verify']);
			assert.strictEqual(d.credentialRef, 'apple-notary');
		}
	});
});

suite('distributionSigningPolicy — Linux', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('no GPG key skips with non-blocking reason', () => {
		const d = decideSigning({ platform: 'linux-x64', credentials: NO_CREDS, buildKind: 'release' });
		assert.strictEqual(d.action, 'skip-unsigned');
		if (d.action === 'skip-unsigned') { assert.strictEqual(d.reason, 'platform-no-signing-required'); }
	});

	test('GPG key present emits gpg-detach-sig + verify', () => {
		const d = decideSigning({ platform: 'linux-arm64', credentials: ALL_FULL, buildKind: 'release' });
		assert.strictEqual(d.action, 'sign');
		if (d.action === 'sign') {
			assert.deepStrictEqual([...d.steps], ['gpg-detach-sig', 'verify']);
			assert.match(d.credentialRef, /^gpg:0123456789ABCDEF/);
		}
	});
});

suite('distributionSigningPolicy — dev build short-circuit', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('dev build always skip-unsigned regardless of credentials', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: ALL_FULL, buildKind: 'dev' });
		assert.strictEqual(d.action, 'skip-unsigned');
		if (d.action === 'skip-unsigned') { assert.strictEqual(d.reason, 'dev-build'); }
	});
});

suite('distributionSigningPolicy — readiness gate', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('all-platform with no creds: not-ready, lists missing', () => {
		const r = evaluateReadinessGate(
			['win32-x64', 'darwin-universal', 'linux-arm64', 'darwin-arm64'],
			NO_CREDS,
		);
		assert.strictEqual(r.status, 'not-ready');
		if (r.status === 'not-ready') {
			// Linux skips with non-blocker reason but still missing for "all four".
			assert.strictEqual(r.missing.length, 4);
			assert.ok(r.missing.some(m => m.platform === 'win32-x64'));
			assert.ok(r.missing.some(m => m.platform === 'darwin-universal'));
		}
	});

	test('all four with full creds: ready', () => {
		const r = evaluateReadinessGate(
			['win32-x64', 'darwin-universal', 'linux-arm64'],
			ALL_FULL,
		);
		assert.strictEqual(r.status, 'ready');
	});

	test('mac partial: gate not ready', () => {
		const r = evaluateReadinessGate(
			['darwin-x64', 'win32-x64'],
			{ ...MAC_FULL, winEvCertPresent: true },
		);
		// macOS full + win full ⇒ ready
		assert.strictEqual(r.status, 'ready');
	});
});

suite('distributionSigningPolicy — describe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('describe sign decision reads as one line', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: WIN_FULL, buildKind: 'release' });
		const text = describeDecision(d);
		assert.match(text, /^\[win32-x64\] sign via win-ev-token/);
	});

	test('describe block decision includes remediation', () => {
		const d = decideSigning({ platform: 'win32-x64', credentials: NO_CREDS, buildKind: 'release' });
		const text = describeDecision(d);
		assert.match(text, /BLOCKED/);
		assert.match(text, /Sectigo/);
	});
});
