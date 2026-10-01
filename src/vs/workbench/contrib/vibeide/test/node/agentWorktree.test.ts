/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile as execFileCallback } from 'child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// The service is plain Node — git through `execFile` — so the Node runner is where it actually runs.
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { VibeideSCMService } from '../../electron-main/vibeideSCMMainService.js';
import { DEFAULT_WORKTREE_INCLUDE_FILES, IWorktreeIncludeOptions } from '../../common/worktreeIncludePolicy.js';
import { WORKTREE_BASE_REF_PREFIX } from '../../common/worktreeBasePolicy.js';
import { worktreeRelativePath } from '../../common/worktreeNaming.js';

const execFile = promisify(execFileCallback);

const BRANCH = 'vibe-agent-тест';

/**
 * Дерево роли на настоящем репозитории: что git на самом деле видит в ссылке, что попадает в коммит и в дифф,
 * и как работа возвращается в папку, где пользователь продолжал править
 */
suite('VibeideSCMService — дерево роли от рабочей папки, с зависимостями', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const git = async (...args: string[]) => (await execFile('git', args, { cwd: root })).stdout.trim();
	const put = async (path: string, text: string) => {
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, text);
	};
	const read = async (path: string) => readFile(path, 'utf8').catch(() => undefined);
	const include = (mode: IWorktreeIncludeOptions['mode']): IWorktreeIncludeOptions => ({ files: DEFAULT_WORKTREE_INCLUDE_FILES, folders: ['node_modules'], mode });

	setup(async function () {
		this.timeout(30_000);
		root = await realpath(await mkdtemp(join(tmpdir(), 'vibe-worktree-')));
		await git('init', '-q', '-b', 'main');
		await git('config', 'user.name', 't');
		await git('config', 'user.email', 't@t');
		await put(join(root, '.gitignore'), 'node_modules/\n.env\n');
		await put(join(root, 'src/a.ts'), 'a1\n');
		await put(join(root, 'src/b.ts'), 'b1\n');
		await git('add', '-A');
		await git('commit', '-q', '-m', 'init');
		await put(join(root, 'node_modules/pkg/index.js'), 'dependency\n');
		await put(join(root, '.env'), 'SECRET=1\n');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	/** Незакоммиченная правка и новый файл пользователя, затем дерево от рабочей папки. */
	const startFromDirtyFolder = async (scm: VibeideSCMService, mode: IWorktreeIncludeOptions['mode']) => {
		await put(join(root, 'src/a.ts'), 'a2 user\n');
		await put(join(root, 'src/new.ts'), 'user new\n');
		const base = await scm.pinWorktreeBase(root, BRANCH);
		const created = await scm.addWorktree(root, BRANCH, worktreeRelativePath(BRANCH), { ...(base ? { baseRef: base } : {}), include: include(mode) });
		return { base, created };
	};

	test('ссылка: дерево видит правки пользователя, ссылка не коммитится, дифф роли — только её работа, удаление не трогает общую папку', async function () {
		this.timeout(60_000);
		const scm = store.add(new VibeideSCMService());
		const { base, created } = await startFromDirtyFolder(scm, 'link');
		const tree = created.path;
		await put(join(tree, 'src/role.ts'), 'role work\n');
		const committed = await scm.commitWorktree(tree, 'роль');
		const changes = await scm.listChanges(root, { kind: 'branch', branch: BRANCH });
		const snapshot = {
			baseIsCommit: typeof base === 'string',
			brought: { linked: created.linked, cloned: created.cloned, copied: created.copied, failed: created.failed },
			seesUserEdit: await read(join(tree, 'src/a.ts')),
			seesUserNewFile: await read(join(tree, 'src/new.ts')),
			isLink: (await lstat(join(tree, 'node_modules'))).isSymbolicLink(),
			env: await read(join(tree, '.env')),
			committed,
			branchFiles: (await git('show', '--name-only', '--format=', BRANCH)).split('\n'),
			roleDiff: changes?.files,
		};
		await scm.removeWorktree(root, tree);
		assert.deepStrictEqual({
			...snapshot,
			dependencyIntact: await read(join(root, 'node_modules/pkg/index.js')),
			treeGone: await read(join(tree, 'src/role.ts')),
		}, {
			baseIsCommit: true,
			brought: { linked: ['node_modules'], cloned: [], copied: ['.env'], failed: [] },
			seesUserEdit: 'a2 user\n',
			seesUserNewFile: 'user new\n',
			isLink: true,
			env: 'SECRET=1\n',
			committed: true,
			branchFiles: ['src/role.ts'],
			roleDiff: [{ status: 'added', path: 'src/role.ts' }],
			dependencyIntact: 'dependency\n',
			treeGone: undefined,
		});
	});

	test('копия: папка зависимостей своя, а не ссылка', async function () {
		this.timeout(60_000);
		const scm = store.add(new VibeideSCMService());
		const { created } = await startFromDirtyFolder(scm, 'clone');
		await put(join(created.path, 'node_modules/pkg/index.js'), 'changed in the role\n');
		assert.deepStrictEqual({
			cloned: created.cloned,
			linked: created.linked,
			isLink: (await lstat(join(created.path, 'node_modules'))).isSymbolicLink(),
			userCopy: await read(join(root, 'node_modules/pkg/index.js')),
		}, {
			cloned: ['node_modules'],
			linked: [],
			isLink: false,
			userCopy: 'dependency\n',
		});
		await scm.removeWorktree(root, created.path, true);
	});

	test('возврат: папка не менялась — работа ложится незакоммиченной, HEAD на месте', async function () {
		this.timeout(60_000);
		const scm = store.add(new VibeideSCMService());
		const { created } = await startFromDirtyFolder(scm, 'none');
		const head = await git('rev-parse', 'HEAD');
		await put(join(created.path, 'src/b.ts'), 'b role\n');
		await rm(join(created.path, 'src/new.ts'));
		await scm.commitWorktree(created.path, 'роль');
		const outcome = await scm.finishWorktreeBranch(root, BRANCH);
		assert.deepStrictEqual({
			outcome,
			head: await git('rev-parse', 'HEAD'),
			b: await read(join(root, 'src/b.ts')),
			userEditKept: await read(join(root, 'src/a.ts')),
			deletedByRole: await read(join(root, 'src/new.ts')),
			modified: (await git('diff', '--name-only')).split('\n'),
			// Индекс пользователя не тронут: работа роли лежит рядом с его правками, а не застейджена за него
			staged: await git('diff', '--cached', '--name-only'),
		}, {
			outcome: { kind: 'applied', files: 2 },
			head,
			b: 'b role\n',
			userEditKept: 'a2 user\n',
			deletedByRole: undefined,
			modified: ['src/a.ts', 'src/b.ts'],
			staged: '',
		});
		await scm.removeWorktree(root, created.path);
		await scm.deleteBranch(root, BRANCH, true);
		await scm.releaseWorktreeBase(root, BRANCH);
		assert.strictEqual(await git('for-each-ref', '--format=%(refname)', WORKTREE_BASE_REF_PREFIX), '');
	});

	test('возврат: папка ушла вперёд — правки сводятся, на тех же строках — конфликт и папка не тронута', async function () {
		this.timeout(60_000);
		const scm = store.add(new VibeideSCMService());
		const { created } = await startFromDirtyFolder(scm, 'none');
		await put(join(created.path, 'src/b.ts'), 'b role\n');
		await scm.commitWorktree(created.path, 'роль');
		await put(join(root, 'src/new.ts'), 'user new, edited after start\n');
		const merged = await scm.finishWorktreeBranch(root, BRANCH);
		const afterMerge = { b: await read(join(root, 'src/b.ts')), userLater: await read(join(root, 'src/new.ts')) };
		await put(join(root, 'src/b.ts'), 'b user, same line\n');
		const conflict = await scm.finishWorktreeBranch(root, BRANCH);
		assert.deepStrictEqual({ merged, afterMerge, conflict, untouched: await read(join(root, 'src/b.ts')) }, {
			merged: { kind: 'applied', files: 1 },
			afterMerge: { b: 'b role\n', userLater: 'user new, edited after start\n' },
			conflict: { kind: 'conflict', files: ['src/b.ts'] },
			untouched: 'b user, same line\n',
		});
		await scm.removeWorktree(root, created.path, true);
	});

	test('чистая папка — база HEAD и прежнее слияние; осиротевшая база снимается уборкой', async function () {
		this.timeout(60_000);
		const scm = store.add(new VibeideSCMService());
		const base = await scm.pinWorktreeBase(root, BRANCH);
		const created = await scm.addWorktree(root, BRANCH, worktreeRelativePath(BRANCH));
		await put(join(created.path, 'src/b.ts'), 'b role\n');
		await scm.commitWorktree(created.path, 'роль');
		const outcome = await scm.finishWorktreeBranch(root, BRANCH);
		await put(join(root, 'src/a.ts'), 'dirty\n');
		await scm.pinWorktreeBase(root, 'vibe-agent-сирота');
		const occupied = await scm.pinWorktreeBase(root, BRANCH).then(() => 'pinned', () => 'refused');
		assert.deepStrictEqual({
			base,
			outcome,
			parents: (await git('log', '-1', '--format=%P')).split(' ').length,
			occupied,
			pruned: await scm.pruneWorktreeBases(root),
			left: await git('for-each-ref', '--format=%(refname)', WORKTREE_BASE_REF_PREFIX),
		}, {
			base: undefined,
			outcome: { kind: 'merged' },
			parents: 2,
			occupied: 'refused',
			pruned: 1,
			left: '',
		});
		await scm.removeWorktree(root, created.path, true);
	});
});
