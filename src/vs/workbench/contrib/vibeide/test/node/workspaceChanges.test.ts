/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile as execFileCallback } from 'child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../../base/common/path.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// The service is plain Node — git through `execFile` — so the Node runner is where it actually runs.
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { VibeideSCMService } from '../../electron-main/vibeideSCMMainService.js';
import { PIPELINE_SNAPSHOT_REF_PREFIX } from '../../common/workspaceChangesPolicy.js';

const execFile = promisify(execFileCallback);

/**
 * A pipeline's diff against a real repository: what git lists and patches is the part no type
 * describes — untracked files, renames, a folder inside the repository, a branch that forked before
 * HEAD moved on.
 */
suite('VibeideSCMService — снимки и дифф прогона на настоящем репозитории', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const git = async (...args: string[]) => (await execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root })).stdout.trim();
	const put = async (path: string, text: string) => {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	};

	setup(async function () {
		this.timeout(30_000);
		root = await realpath(await mkdtemp(join(tmpdir(), 'vibe-changes-')));
		await git('init', '-q', '-b', 'main');
		await put('src/a.ts', 'export const a = 1;\n');
		await put('src/x.ts', 'export const moved = "body that stays the same across the rename";\n');
		await put('old.txt', 'a long text that should not be shown\n'.repeat(20));
		await put('pkg/app/main.ts', 'main\n');
		await git('add', '-A');
		await git('commit', '-q', '-m', 'init');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('from a pin: a changed, a new untracked, a deleted and a renamed file — the deletion by its header only', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const base = await scm.pinPipelineSnapshot(root, 'run1', 'base');
		await put('src/a.ts', 'export const a = 2;\n');
		await put('док/заметка.md', '# Заметка\n');
		await rm(join(root, 'old.txt'));
		await git('mv', 'src/x.ts', 'src/y.ts');
		const set = await scm.listChanges(root, { kind: 'snapshot', commit: base! });
		const sections = await scm.diffChanges(root, set!.from, set!.to, set!.files, 100_000);
		assert.deepStrictEqual({
			pinned: (await git('for-each-ref', '--format=%(refname)', PIPELINE_SNAPSHOT_REF_PREFIX)).split('\n'),
			prefix: set!.prefix,
			files: set!.files,
			headers: sections.map(section => section.split('\n')[0]),
			deletedWithoutText: sections.find(section => section.includes('old.txt'))?.includes('should not be shown'),
			unquoted: sections.some(section => section.includes('+# Заметка')),
		}, {
			pinned: [`${PIPELINE_SNAPSHOT_REF_PREFIX}/run1/base`],
			prefix: '',
			files: [
				{ status: 'deleted', path: 'old.txt' },
				{ status: 'modified', path: 'src/a.ts' },
				{ status: 'renamed', path: 'src/y.ts', oldPath: 'src/x.ts' },
				{ status: 'added', path: 'док/заметка.md' },
			],
			headers: [
				'diff --git a/old.txt b/old.txt',
				'diff --git a/src/a.ts b/src/a.ts',
				'diff --git a/src/x.ts b/src/y.ts',
				'diff --git a/док/заметка.md b/док/заметка.md',
			],
			deletedWithoutText: false,
			unquoted: true,
		});
	});

	test('a folder inside the repository learns its prefix; collection stops past the budget', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const base = await scm.pinPipelineSnapshot(join(root, 'pkg', 'app'), 'run2', 'base');
		await put('pkg/app/main.ts', 'main changed\n');
		await put('pkg/app/extra.ts', 'extra\n');
		const set = await scm.listChanges(join(root, 'pkg', 'app'), { kind: 'snapshot', commit: base! });
		const first = await scm.diffChanges(root, set!.from, set!.to, set!.files, 10);
		assert.deepStrictEqual({ prefix: set!.prefix, paths: set!.files.map(file => file.path), stoppedAfter: first.length }, {
			prefix: 'pkg/app/',
			paths: ['pkg/app/extra.ts', 'pkg/app/main.ts'],
			stoppedAfter: 1,
		});
	});

	test('pathspecs are literal: a file named with a star is that file, not a pattern', async function () {
		if (isWindows) {
			this.skip();
		}
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const base = await scm.pinPipelineSnapshot(root, 'run3', 'base');
		await put('star*.md', 'literal\n');
		await put('starX.md', 'other\n');
		const set = await scm.listChanges(root, { kind: 'snapshot', commit: base! });
		const sections = await scm.diffChanges(root, set!.from, set!.to, set!.files.filter(file => file.path === 'star*.md'), 100_000);
		assert.deepStrictEqual(sections.map(section => section.split('\n')[0]), ['diff --git a/star*.md b/star*.md']);
	});

	test('an agent branch is compared with where it forked, not with a HEAD that moved on', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		await git('checkout', '-q', '-b', 'vibe-agent-шаг-2');
		await put('src/agent.ts', 'agent work\n');
		await git('add', '-A');
		await git('commit', '-q', '-m', 'agent');
		await git('checkout', '-q', 'main');
		await put('src/a.ts', 'moved on\n');
		await git('commit', '-q', '-am', 'main moved');
		const set = await scm.listChanges(root, { kind: 'branch', branch: 'vibe-agent-шаг-2' });
		assert.deepStrictEqual({
			files: set!.files,
			refusedOption: await scm.listChanges(root, { kind: 'branch', branch: '--output=/tmp/x' }),
		}, {
			files: [{ status: 'added', path: 'src/agent.ts' }],
			refusedOption: undefined,
		});
	});

	test('release drops the run\'s pins; prune drops only runs older than the limit', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		await scm.pinPipelineSnapshot(root, 'done', 'base');
		await scm.pinPipelineSnapshot(root, 'done', 'step-2');
		await scm.pinPipelineSnapshot(root, 'other', 'base');
		await scm.releasePipelineSnapshots(root, 'done');
		const afterRelease = (await git('for-each-ref', '--format=%(refname)', PIPELINE_SNAPSHOT_REF_PREFIX)).split('\n');
		const young = await scm.prunePipelineSnapshots(root, 60 * 60 * 1000);
		const everything = await scm.prunePipelineSnapshots(root, 0);
		assert.deepStrictEqual({
			afterRelease,
			young,
			everything,
			left: await git('for-each-ref', '--format=%(refname)', PIPELINE_SNAPSHOT_REF_PREFIX),
		}, {
			afterRelease: [`${PIPELINE_SNAPSHOT_REF_PREFIX}/other/base`],
			young: 0,
			everything: 1,
			left: '',
		});
	});
});
