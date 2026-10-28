/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { findMountEntry, isLocalVolume, parseMountTable } from '../../node/watcher/nodejs/macMountTable.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';

suite('macOS mount table — local volume detection', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const table = parseMountTable([
		'/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
		'/dev/disk5s1 on /Volumes/ExVint (apfs, local, nodev, nosuid, journaled, noowners)',
		'/dev/disk9s1 on /Volumes/My Disk (apfs, local, journaled)',
		'/dev/disk7s1 on /Volumes/Mixed (apfs, local, journaled)',
		'//guest@server/share on /Volumes/Team (smbfs, nodev, nosuid, mounted by guest)',
		'server:/export on /Volumes/NFS (nfs, nodev, nosuid)',
		'//guest@server/share on /Volumes/Mixed/share (smbfs, nodev, nosuid)'
	].join('\n'));

	test('local APFS volume under /Volumes is allowed', () => {
		assert.strictEqual(isLocalVolume('/Volumes/ExVint/work/projects/self/temp/.vibe/hooks.json', table), true);
		assert.strictEqual(isLocalVolume('/Volumes/My Disk/project', table), true);
	});

	test('SMB and NFS shares under /Volumes stay refused', () => {
		assert.strictEqual(isLocalVolume('/Volumes/Team/project', table), false);
		assert.strictEqual(isLocalVolume('/Volumes/NFS/project', table), false);
	});

	test('longest matching mount point wins', () => {
		assert.strictEqual(isLocalVolume('/Volumes/Mixed/other', table), true);
		assert.strictEqual(isLocalVolume('/Volumes/Mixed/share/file', table), false);
		assert.strictEqual(findMountEntry('/Volumes/Mixed/share/file', table)?.mountPoint, '/Volumes/Mixed/share');
	});

	test('unknown paths are refused instead of falling back to the root mount', () => {
		assert.strictEqual(isLocalVolume('/Volumes/Unknown/file', table), false);
		assert.strictEqual(isLocalVolume('/Volumes/ExVint/file', []), false);
	});

	test('malformed mount lines are ignored', () => {
		assert.deepStrictEqual(parseMountTable('garbage\n\n'), []);
	});
});
