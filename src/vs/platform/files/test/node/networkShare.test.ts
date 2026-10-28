/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isNetworkFileSystemType } from '../../node/watcher/nodejs/networkShare.js';

suite('Network file system detection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('local APFS is not a network share', () => {
		// / and /Volumes/<local disk> report this type on macOS.
		assert.strictEqual(isNetworkFileSystemType(26), false);
	});

	test('local devices are not a network share', () => {
		assert.strictEqual(isNetworkFileSystemType(19), false);
	});

	test('macOS network file systems are detected', () => {
		assert.strictEqual(isNetworkFileSystemType(18), true); // smbfs
		assert.strictEqual(isNetworkFileSystemType(20), true); // nfs
		assert.strictEqual(isNetworkFileSystemType(21), true); // webdav
	});
});
