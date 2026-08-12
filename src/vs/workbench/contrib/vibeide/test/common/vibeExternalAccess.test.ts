/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isPathAllowed, normalizeFolderPath, resolveSourceFolders } from '../../common/vibeExternalAccessService.js';

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

suite('vibeExternalAccess — reference folders are read-only', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a reference folder answers yes to read and no to write', () => {
		const writable = ['/work/project'];
		const reference = ['/home/notes'];
		const readFolders = [...writable, ...reference];
		assert.deepStrictEqual(
			{
				readInReference: isPathAllowed('/home/notes/idea.md', readFolders, true),
				writeInReference: isPathAllowed('/home/notes/idea.md', writable, true),
				writeInAllowlist: isPathAllowed('/work/project/a.ts', writable, true),
				// Boundary, not substring: allowing /home/notes must not leak /home/notes-secret.
				neighbour: isPathAllowed('/home/notes-secret/x.md', readFolders, true),
			},
			{ readInReference: true, writeInReference: false, writeInAllowlist: true, neighbour: false },
		);
	});
});

suite('vibeExternalAccess — source folders inside the workspace', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a relative entry expands against EVERY workspace root', () => {
		// Expanding only the first root would leave the other projects writable — silently, which
		// is the exact failure this setting exists to prevent.
		assert.deepStrictEqual(
			resolveSourceFolders(['raw'], ['/w/one', '/w/two']),
			['/w/one/raw', '/w/two/raw'],
		);
	});

	test('junk entries are dropped instead of matching everything', () => {
		// An empty or `..` entry resolved to the root itself would freeze the whole project.
		assert.deepStrictEqual(
			resolveSourceFolders(['', '   ', '../escape', './docs/sources/', 'raw\\nested'], ['/w']),
			['/w/docs/sources', '/w/raw/nested'],
		);
	});

	test('absolute entries pass through untouched', () => {
		assert.deepStrictEqual(
			resolveSourceFolders(['/mnt/archive', 'C:\\corpus'], ['/w']),
			['/mnt/archive', 'C:\\corpus'],
		);
	});

	test('protection covers the folder and its contents, and stops at the boundary', () => {
		const folders = resolveSourceFolders(['raw'], ['/w']);
		assert.deepStrictEqual(
			{
				folder: isPathAllowed('/w/raw', folders, true),
				inside: isPathAllowed('/w/raw/talks/2026.md', folders, true),
				lookalike: isPathAllowed('/w/raw-notes/x.md', folders, true),
				elsewhere: isPathAllowed('/w/docs/x.md', folders, true),
			},
			{ folder: true, inside: true, lookalike: false, elsewhere: false },
		);
	});
});
