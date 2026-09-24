/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	chunkChangedFiles,
	isSafeBranchName,
	parseNameStatusZ,
	parsePipelineRunRefs,
	pipelineSnapshotRef,
	selectStaleRunRefs,
	splitPatchSections,
} from '../../common/workspaceChangesPolicy.js';

suite('workspaceChangesPolicy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('name-status with NUL separators keeps every path verbatim, renames with both ends', () => {
		assert.deepStrictEqual(parseNameStatusZ('M\0src/a b.ts\0A\0док/заметка.md\0D\0old.txt\0R087\0src/x.ts\0src/y.ts\0T\0link\0'), [
			{ status: 'modified', path: 'src/a b.ts' },
			{ status: 'added', path: 'док/заметка.md' },
			{ status: 'deleted', path: 'old.txt' },
			{ status: 'renamed', path: 'src/y.ts', oldPath: 'src/x.ts' },
			{ status: 'modified', path: 'link' },
		]);
	});

	test('a patch splits into one section per file, each ending in one line break', () => {
		const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-diff --git fake\n+x\n\ndiff --git a/b.md b/b.md\nnew file mode 100644\n';
		assert.deepStrictEqual(splitPatchSections(patch), [
			'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-diff --git fake\n+x\n',
			'diff --git a/b.md b/b.md\nnew file mode 100644\n',
		]);
	});

	test('files go to git in groups, a rename never split from its other end', () => {
		const files = [
			{ status: 'modified' as const, path: 'a' },
			{ status: 'renamed' as const, path: 'c', oldPath: 'b' },
			{ status: 'added' as const, path: 'd' },
		];
		assert.deepStrictEqual(chunkChangedFiles(files, 2).map(chunk => chunk.map(file => file.path)), [['a'], ['c'], ['d']]);
	});

	test('snapshot refs take only plain names, branches only what cannot pass for an option or a range', () => {
		assert.deepStrictEqual({
			ref: pipelineSnapshotRef('3f2a-9c', 'step-3'),
			badRun: (() => { try { pipelineSnapshotRef('../x', 'base'); return 'accepted'; } catch { return 'refused'; } })(),
			badLabel: (() => { try { pipelineSnapshotRef('run', 'a.lock'); return 'accepted'; } catch { return 'refused'; } })(),
			agentBranch: isSafeBranchName('vibe-agent-правка-2'),
			option: isSafeBranchName('--output=/tmp/x'),
			range: isSafeBranchName('main..evil'),
			lock: isSafeBranchName('x.lock'),
		}, {
			ref: 'refs/vibe/pipelines/3f2a-9c/step-3',
			badRun: 'refused',
			badLabel: 'refused',
			agentBranch: true,
			option: false,
			range: false,
			lock: false,
		});
	});

	test('a run is left behind only when all its pins are old — a run that pinned lately is alive', () => {
		const now = 100 * 24 * 60 * 60 * 1000;
		const refs = parsePipelineRunRefs([
			`refs/vibe/pipelines/old/base ${(now - 30 * 60 * 60 * 1000) / 1000}`,
			`refs/vibe/pipelines/old/step-2 ${(now - 29 * 60 * 60 * 1000) / 1000}`,
			`refs/vibe/pipelines/live/base ${(now - 30 * 60 * 60 * 1000) / 1000}`,
			`refs/vibe/pipelines/live/step-4 ${(now - 60 * 1000) / 1000}`,
			'refs/vibe/checkpoints/abc 1',
		].join('\n'));
		assert.deepStrictEqual(selectStaleRunRefs(refs, now), { refs: ['refs/vibe/pipelines/old/base', 'refs/vibe/pipelines/old/step-2'], runs: 1 });
	});
});
