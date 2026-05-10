#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Self-contained smoke test for scripts/check-i18n-bundle-version.mjs.
// Run: `node scripts/check-i18n-bundle-version.test.mjs`. No deps.

import assert from 'node:assert/strict';
import { checkBundleVersionSync, describeBundleVersionVerdict } from './check-i18n-bundle-version.mjs';

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		console.error(`FAIL - ${name}\n  ${e.message}`);
		process.exitCode = 1;
	}
}

test('checkBundleVersionSync: identical → in-sync', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.4.2', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'in-sync');
	assert.equal(r.version, '0.4.2');
});

test('checkBundleVersionSync: trims whitespace before equality', () => {
	const r = checkBundleVersionSync({ ideVersion: ' 0.4.2 ', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'in-sync');
});

test('checkBundleVersionSync: major drift', () => {
	const r = checkBundleVersionSync({ ideVersion: '1.0.0', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'mismatch');
	assert.equal(r.drift, 'major');
});

test('checkBundleVersionSync: minor drift', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.5.0', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'mismatch');
	assert.equal(r.drift, 'minor');
});

test('checkBundleVersionSync: patch drift', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.4.3', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'mismatch');
	assert.equal(r.drift, 'patch');
});

test('checkBundleVersionSync: pre-release ignored for drift level', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.4.2-alpha.1', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'mismatch');
	assert.equal(r.drift, 'patch'); // major/minor/patch identical → fall through to patch
});

test('checkBundleVersionSync: build metadata accepted', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.4.2+sha.abc', bundleVersion: '0.4.2+sha.def' });
	assert.equal(r.kind, 'mismatch');
	assert.equal(r.drift, 'patch');
});

test('checkBundleVersionSync: unparseable on either side', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.4.2', bundleVersion: 'not-a-version' });
	assert.equal(r.kind, 'mismatch');
	assert.equal(r.drift, 'unparseable');
});

test('checkBundleVersionSync: missing ide → invalid-input', () => {
	const r = checkBundleVersionSync({ ideVersion: undefined, bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'invalid-input');
	assert.equal(r.reason, 'ide-missing');
});

test('checkBundleVersionSync: missing bundle → invalid-input', () => {
	const r = checkBundleVersionSync({ ideVersion: '0.4.2', bundleVersion: undefined });
	assert.equal(r.kind, 'invalid-input');
	assert.equal(r.reason, 'bundle-missing');
});

test('checkBundleVersionSync: non-string ide → invalid-input', () => {
	const r = checkBundleVersionSync({ ideVersion: 42, bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'invalid-input');
	assert.equal(r.reason, 'ide-not-string');
});

test('checkBundleVersionSync: empty trimmed ide → ide-malformed', () => {
	const r = checkBundleVersionSync({ ideVersion: '   ', bundleVersion: '0.4.2' });
	assert.equal(r.kind, 'invalid-input');
	assert.equal(r.reason, 'ide-malformed');
});

test('describeBundleVersionVerdict: in-sync includes version', () => {
	const s = describeBundleVersionVerdict({ kind: 'in-sync', version: '0.4.2' });
	assert.match(s, /0\.4\.2/);
	assert.match(s, /OK/);
});

test('describeBundleVersionVerdict: mismatch contains both versions and rebuild hint', () => {
	const s = describeBundleVersionVerdict({
		kind: 'mismatch',
		ideVersion: '0.4.2',
		bundleVersion: '0.4.1',
		drift: 'patch',
	});
	assert.match(s, /0\.4\.2/);
	assert.match(s, /0\.4\.1/);
	assert.match(s, /patch/);
	assert.match(s, /Rebuild/);
});

test('describeBundleVersionVerdict: invalid-input mentions reason', () => {
	const s = describeBundleVersionVerdict({ kind: 'invalid-input', reason: 'bundle-missing' });
	assert.match(s, /bundle-missing/);
});

console.log(`\n${passed} passed`);
