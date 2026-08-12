/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isSnapshotTreeId, parsePathList, parsePinnedSnapshots, planSnapshotRestore, selectStaleSnapshotRefs, shouldReuseSnapshot, snapshotCommitMessage } from '../../common/workspaceSnapshotPolicy.js';

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

	const NOW = 10_000_000_000;
	const OLD = NOW - 5 * 60 * 60 * 1000;

	test('parses refs with their age and ignores anything outside our namespace', () => {
		assert.deepStrictEqual(
			parsePinnedSnapshots('refs/vibe/checkpoints/abc 1700000000\nrefs/heads/main 1700000001\nrefs/vibe/other/x 1700000002\n\n'),
			[{ id: 'abc', committedAtMs: 1700000000000 }],
		);
	});

	test('stale refs: only snapshots no checkpoint points at are released', () => {
		const live = 'a'.repeat(40);
		const dead = 'b'.repeat(40);
		assert.deepStrictEqual(
			selectStaleSnapshotRefs(
				[{ id: live, committedAtMs: OLD }, { id: dead, committedAtMs: OLD }],
				[live],
				NOW,
			),
			[dead],
		);
	});

	// The dangerous direction: another window may have just written a checkpoint that has not reached
	// storage yet, so a young snapshot is spared even when it looks unreferenced.
	test('a snapshot younger than the grace period is never released', () => {
		assert.deepStrictEqual(
			selectStaleSnapshotRefs([{ id: 'fresh', committedAtMs: NOW - 60_000 }], [], NOW),
			[],
		);
	});

	test('stale refs: an empty live set releases every old pinned snapshot', () => {
		assert.deepStrictEqual(
			selectStaleSnapshotRefs([{ id: 'deadbeef', committedAtMs: OLD }], [], NOW),
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

suite('workspaceSnapshotPolicy — подпись снимка и пропуск неизменённого', () => {

	test('сообщение несёт ход, инструмент и дерево; первая строка коротка для --oneline', () => {
		const msg = snapshotCommitMessage('abc123', { turnIndex: 7, toolName: 'edit_file', threadId: 't1' });
		const [head, blank, ...body] = msg.split('\n');
		assert.deepStrictEqual(
			[head, blank, body.join('|')],
			['VibeIDE checkpoint: ход 7 (edit_file)', '', 'tree abc123|turnIndex 7|toolName edit_file|threadId t1'],
		);
	});

	test('без метаданных сообщение остаётся прежним — снимок ценен и без подписи', () => {
		assert.match(snapshotCommitMessage('abc123'), /^VibeIDE checkpoint snapshot\n\ntree abc123$/);
	});

	test('то же дерево — переиспользуем прошлый снимок; другое или пустое — нет', () => {
		assert.deepStrictEqual(
			[
				shouldReuseSnapshot('aaa', 'aaa'),
				shouldReuseSnapshot('aaa\n', ' aaa '),
				shouldReuseSnapshot('aaa', 'bbb'),
				shouldReuseSnapshot('aaa', undefined),
				shouldReuseSnapshot('', ''),
			],
			[true, true, false, false, false],
		);
	});
});
