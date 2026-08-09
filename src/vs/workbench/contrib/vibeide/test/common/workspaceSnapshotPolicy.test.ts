/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isSnapshotTreeId, parsePathList, planSnapshotRestore, selectStaleSnapshotRefs } from '../../common/workspaceSnapshotPolicy.js';

suite('Workspace snapshot policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recognises tree ids and rejects anything else', () => {
		assert.deepStrictEqual(
			{
				sha1: isSnapshotTreeId('69ebc5b477ffcd805e27eaeab1e026d5a286c2c4'),
				sha256: isSnapshotTreeId('a'.repeat(64)),
				short: isSnapshotTreeId('69ebc5b'),
				branch: isSnapshotTreeId('HEAD'),
				injection: isSnapshotTreeId('HEAD; rm -rf /'),
				missing: isSnapshotTreeId(undefined),
			},
			{ sha1: true, sha256: true, short: false, branch: false, injection: false, missing: false },
		);
	});

	test('parses git path output, dropping blank lines', () => {
		assert.deepStrictEqual(parsePathList('a.txt\r\nsub/b.txt\n\n  c.txt  \n'), ['a.txt', 'sub/b.txt', 'c.txt']);
	});

	test('plans restore: snapshot files are written, files created since are deleted', () => {
		assert.deepStrictEqual(
			planSnapshotRestore(['tracked.txt', 'sub/deep.txt'], ['tracked.txt', 'garbage.txt']),
			{ restore: ['sub/deep.txt', 'tracked.txt'], delete: ['garbage.txt'] },
		);
	});

	test('stale refs: only snapshots no checkpoint points at are released', () => {
		const live = 'a'.repeat(40);
		const dead = 'b'.repeat(40);
		assert.deepStrictEqual(
			selectStaleSnapshotRefs(
				[`refs/vibe/checkpoints/${live}`, `refs/vibe/checkpoints/${dead}`, 'refs/heads/main'],
				[live],
			),
			[dead],
		);
	});

	test('stale refs: an empty live set releases everything pinned, and only under our prefix', () => {
		assert.deepStrictEqual(
			selectStaleSnapshotRefs(['refs/vibe/checkpoints/deadbeef', 'refs/tags/v1', 'refs/vibe/other/x'], []),
			['deadbeef'],
		);
	});

	test('nothing to delete when the tree only grew inside the snapshot', () => {
		assert.deepStrictEqual(
			planSnapshotRestore(['a', 'b'], ['a']),
			{ restore: ['a', 'b'], delete: [] },
		);
	});
});
