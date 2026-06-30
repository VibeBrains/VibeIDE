/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPathAllowed, normalizeFolderPath } from '../../common/vibeExternalAccessService.js';

suite('vibeExternalAccess — per-folder allowlist (O.13 Variant A)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exact folder match is allowed', () => {
		assert.strictEqual(isPathAllowed('/a/proj', ['/a/proj'], true), true);
	});

	test('file inside an allowed folder is allowed', () => {
		assert.strictEqual(isPathAllowed('/a/proj/src/x.ts', ['/a/proj'], true), true);
	});

	test('folder BOUNDARY — no substring leak', () => {
		// Allowing /a/proj must NOT allow the sibling /a/project-secret.
		assert.strictEqual(isPathAllowed('/a/project-secret/x', ['/a/proj'], true), false);
	});

	test('unrelated path is denied', () => {
		assert.strictEqual(isPathAllowed('/b/other/x', ['/a/proj'], true), false);
	});

	test('trailing slash on the allowed folder is tolerated', () => {
		assert.strictEqual(isPathAllowed('/a/proj/x', ['/a/proj/'], true), true);
	});

	test('backslash paths normalize to forward-slash for matching', () => {
		assert.strictEqual(isPathAllowed('C:\\a\\proj\\x.ts', ['C:/a/proj'], false), true);
	});

	test('case sensitivity honored', () => {
		assert.strictEqual(isPathAllowed('/A/Proj/x', ['/a/proj'], false), true);  // win-style: case-insensitive
		assert.strictEqual(isPathAllowed('/A/Proj/x', ['/a/proj'], true), false);  // posix: case-sensitive
	});

	test('empty allowlist denies everything', () => {
		assert.strictEqual(isPathAllowed('/a/proj/x', [], true), false);
	});

	test('empty folder entry never matches (no match-all)', () => {
		assert.strictEqual(isPathAllowed('/a/proj/x', ['', '   '.trim()], true), false);
	});

	test('normalizeFolderPath strips trailing slashes and lowercases when case-insensitive', () => {
		assert.strictEqual(normalizeFolderPath('C:\\A\\B\\', false), 'c:/a/b');
		assert.strictEqual(normalizeFolderPath('/A/B/', true), '/A/B');
	});
});
