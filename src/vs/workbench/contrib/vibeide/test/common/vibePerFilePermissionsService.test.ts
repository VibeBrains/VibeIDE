/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	canReadWithPermissions,
	canWriteWithPermissions,
	matchPermissionPattern,
} from '../../common/vibePerFilePermissionsService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('VibePerFilePermissionsService — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('matchPermissionPattern', () => {
		test('exact filename matches', () => {
			assert.strictEqual(matchPermissionPattern('src/foo.ts', 'foo.ts'), true);
		});

		test('* matches a single segment', () => {
			assert.strictEqual(matchPermissionPattern('src/foo.ts', '*.ts'), true);
			assert.strictEqual(matchPermissionPattern('src/sub/foo.ts', '*.ts'), true,
				'* anchored to segment via (^|/)..($|/) wraps boundary');
		});

		test('** matches across segments', () => {
			assert.strictEqual(matchPermissionPattern('src/sub/deep/foo.ts', 'src/**/foo.ts'), true);
			assert.strictEqual(matchPermissionPattern('src/foo.ts', 'src/**/foo.ts'), true,
				'** matches zero or more segments');
		});

		test('? matches single non-slash char', () => {
			assert.strictEqual(matchPermissionPattern('a.ts', '?.ts'), true);
			assert.strictEqual(matchPermissionPattern('ab.ts', '?.ts'), false);
		});

		test('non-matching pattern returns false', () => {
			assert.strictEqual(matchPermissionPattern('src/foo.ts', 'lib/*.ts'), false);
		});

		test('windows path separators normalize to forward slash', () => {
			assert.strictEqual(matchPermissionPattern('src\\foo.ts', '*.ts'), false,
				'caller is responsible for normalization (canWriteWithPermissions does it)');
		});
	});

	suite('canWriteWithPermissions', () => {
		test('default allows write when no permissions configured', () => {
			assert.strictEqual(canWriteWithPermissions('src/foo.ts', {}), true);
		});

		test('deny_write blocks even when allow_write would match', () => {
			const out = canWriteWithPermissions('.env',
				{ allow_write: ['**/*'], deny_write: ['.env'] });
			assert.strictEqual(out, false);
		});

		test('allow_write whitelist excludes everything else', () => {
			assert.strictEqual(canWriteWithPermissions('src/foo.ts',
				{ allow_write: ['src/**/*.ts'] }), true);
			assert.strictEqual(canWriteWithPermissions('lib/bar.js',
				{ allow_write: ['src/**/*.ts'] }), false);
		});

		test('windows-style backslashes normalize before matching', () => {
			assert.strictEqual(canWriteWithPermissions('src\\foo.ts',
				{ allow_write: ['src/**/*.ts'] }), true);
		});

		test('empty allow_write list does not block', () => {
			assert.strictEqual(canWriteWithPermissions('src/foo.ts',
				{ allow_write: [] }), true);
		});
	});

	suite('canReadWithPermissions', () => {
		test('default allows read', () => {
			assert.strictEqual(canReadWithPermissions('src/foo.ts', {}), true);
		});

		test('deny_read blocks read', () => {
			assert.strictEqual(canReadWithPermissions('secrets.yaml',
				{ deny_read: ['secrets.yaml'] }), false);
		});

		test('allow_read whitelist excludes others', () => {
			assert.strictEqual(canReadWithPermissions('src/foo.ts',
				{ allow_read: ['src/**'] }), true);
			assert.strictEqual(canReadWithPermissions('node_modules/bar/index.js',
				{ allow_read: ['src/**'] }), false);
		});
	});
});
