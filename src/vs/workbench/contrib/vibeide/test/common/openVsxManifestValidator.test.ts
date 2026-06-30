/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	validateOpenVsxManifest,
	describeValidationResult,
} from '../../common/openVsxManifestValidator.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const MINIMAL_OK = {
	name: 'vibeide-sample',
	displayName: 'VibeIDE Sample Extension',
	description: 'Acceptance proof for the VibeIDE proposed-API surface — calls one accessor.',
	version: '0.1.0',
	publisher: 'vibeide',
	license: 'MIT',
	engines: { vscode: '^1.118.0' },
	repository: 'https://github.com/borodatych/VibeIDE',
	categories: ['Other'],
};

suite('openVsxManifestValidator — happy path', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('minimal valid manifest passes', () => {
		const r = validateOpenVsxManifest(MINIMAL_OK);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.issues.filter(i => i.severity === 'error').length, 0);
	});
});

suite('openVsxManifestValidator — required fields', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('missing name → error', () => {
		const m = { ...MINIMAL_OK, name: undefined };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'name' && i.severity === 'error'));
	});

	test('empty description → error', () => {
		const m = { ...MINIMAL_OK, description: '' };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'description' && i.severity === 'error'));
	});

	test('short description → warning, not error', () => {
		const m = { ...MINIMAL_OK, description: 'short' };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, true);
		assert.ok(r.issues.some(i => i.field === 'description' && i.severity === 'warning'));
	});

	test('missing repository → error', () => {
		const m = { ...MINIMAL_OK, repository: undefined };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'repository' && i.severity === 'error'));
	});

	test('repository as object with url string passes', () => {
		const m = { ...MINIMAL_OK, repository: { type: 'git', url: 'https://github.com/x/y.git' } };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, true);
	});
});

suite('openVsxManifestValidator — license + version', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('non-SemVer version → error', () => {
		const m = { ...MINIMAL_OK, version: '0.1' };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'version' && i.severity === 'error'));
	});

	test('proprietary license string → error', () => {
		const m = { ...MINIMAL_OK, license: 'Proprietary' };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'license' && i.severity === 'error'));
	});

	test('SEE LICENSE IN custom is accepted', () => {
		const m = { ...MINIMAL_OK, license: 'SEE LICENSE IN LICENSE.txt' };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, true);
	});

	test('engines.vscode missing → error', () => {
		const m = { ...MINIMAL_OK, engines: {} };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'engines.vscode' && i.severity === 'error'));
	});

	test('engines.vscode without semver prefix → error', () => {
		const m = { ...MINIMAL_OK, engines: { vscode: '1.118.0' } };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'engines.vscode' && i.severity === 'error'));
	});
});

suite('openVsxManifestValidator — categories', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('empty categories → warning', () => {
		const m = { ...MINIMAL_OK, categories: [] };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, true);
		assert.ok(r.issues.some(i => i.field === 'categories' && i.severity === 'warning'));
	});

	test('non-standard category "VibeIDE" → warning, not error', () => {
		const m = { ...MINIMAL_OK, categories: ['VibeIDE'] };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, true);
		assert.ok(r.issues.some(i => i.field === 'categories[0]' && i.severity === 'warning'));
	});

	test('numeric in categories array → error', () => {
		const m = { ...MINIMAL_OK, categories: [123 as unknown as string] };
		const r = validateOpenVsxManifest(m);
		assert.strictEqual(r.ok, false);
		assert.ok(r.issues.some(i => i.field === 'categories[0]' && i.severity === 'error'));
	});
});

suite('openVsxManifestValidator — describe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('describe lists status + counts + per-issue line', () => {
		const m = { ...MINIMAL_OK, description: '' };
		const r = validateOpenVsxManifest(m);
		const text = describeValidationResult(r);
		assert.match(text, /Open VSX manifest: FAILED/);
		assert.match(text, /\[ERROR\] description:/);
	});

	test('happy path describe is OK with 0 errors', () => {
		const r = validateOpenVsxManifest(MINIMAL_OK);
		const text = describeValidationResult(r);
		assert.match(text, /Open VSX manifest: OK/);
	});
});
