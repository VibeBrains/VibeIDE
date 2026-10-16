/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFile as execFileCallback } from 'child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// The service is plain Node — git through `execFile` — so the Node runner is where it actually runs.
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { VibeideSCMService } from '../../electron-main/vibeideSCMMainService.js';
import { parseSnapshotCommitMessage, snapshotRefName } from '../../common/workspaceSnapshotPolicy.js';

const execFile = promisify(execFileCallback);

/**
 * The checkpoint contract on a real repository (`checkpointSpec.md`, section 13, point 2):
 * snapshot → edits and a new file in the folder → restore → the folder equals the snapshot,
 * while `git status` and the index are what they were. What the vectors cannot say: what git
 * itself prints for a non-ASCII name, and whether a file edited in place counts as a change.
 */
suite('VibeideSCMService — снимок рабочей папки и откат на настоящем репозитории', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	const git = async (...args: string[]) => (await execFile('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: root })).stdout;
	const put = async (path: string, text: string) => {
		await mkdir(join(root, path, '..'), { recursive: true });
		await writeFile(join(root, path), text);
	};
	const read = (path: string) => readFile(join(root, path), 'utf8').catch(() => undefined);
	/** What the user sees of the repository: `git status` and what is staged, byte for byte. */
	const userView = async () => ({
		status: await git('status', '--porcelain=v1', '-z'),
		index: await git('ls-files', '-s', '-z'),
		head: await git('rev-parse', 'HEAD'),
		branches: await git('branch', '-a', '--format=%(refname)'),
	});

	setup(async function () {
		this.timeout(30_000);
		root = await realpath(await mkdtemp(join(tmpdir(), 'vibe-snapshot-')));
		await git('init', '-q', '-b', 'main');
		await put('.gitignore', 'dist/\n');
		await put('src/a.ts', 'export const a = 1;\n');
		await put('src/b.ts', 'export const b = 1;\n');
		await put('док/план.md', '# План\n');
		await git('add', '-A');
		await git('commit', '-q', '-m', 'init');
		// Staged work of the user and an ignored build output: the snapshot must leave the first alone and never delete the second
		await put('src/b.ts', 'export const b = 2;\n');
		await git('add', 'src/b.ts');
		await put('dist/out.js', 'built\n');
	});

	teardown(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test('откат возвращает папку: правка на месте, созданные файлы (и с не-ASCII именем) удалены, игнорируемое и индекс целы', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const before = await userView();
		const snapshot = await scm.createWorkspaceSnapshot(root, { turnIndex: 1, threadId: 'thread-1', agent: 'builtin' });
		assert.ok(snapshot, 'снимок не создан');
		assert.deepStrictEqual(await userView(), before, 'снимок тронул индекс, ветки или HEAD');

		// What the terminal does: edit in place, delete, create — with plain and non-ASCII names
		await put('src/a.ts', 'export const a = "edited in the terminal";\n');
		await rm(join(root, 'док', 'план.md'));
		await put('new.txt', 'created\n');
		await put('новый файл.txt', 'создан\n');
		await put('dist/out.js', 'rebuilt\n');
		const dirty = await userView();

		const plan = await scm.planWorkspaceSnapshotRestore(root, snapshot);
		assert.deepStrictEqual(
			{ delete: plan.delete, changed: plan.changed, restore: plan.restore },
			{
				// Without `-z` git prints the non-ASCII names in quotes, they are not found on disk, and the delete does nothing
				delete: ['new.txt', 'новый файл.txt'],
				changed: ['new.txt', 'src/a.ts', 'док/план.md', 'новый файл.txt'],
				restore: ['.gitignore', 'src/a.ts', 'src/b.ts', 'док/план.md'],
			},
		);
		assert.deepStrictEqual(await userView(), dirty, 'план тронул индекс или рабочую папку');

		await scm.restoreWorkspaceSnapshot(root, snapshot);
		assert.deepStrictEqual(
			{
				edited: await read('src/a.ts'),
				deletedBack: await read('док/план.md'),
				staged: await read('src/b.ts'),
				created: await read('new.txt'),
				createdNonAscii: await read('новый файл.txt'),
				ignored: await read('dist/out.js'),
			},
			{
				edited: 'export const a = 1;\n',
				deletedBack: '# План\n',
				staged: 'export const b = 2;\n',
				created: undefined,
				createdNonAscii: undefined,
				ignored: 'rebuilt\n',
			},
		);
		assert.deepStrictEqual(await userView(), before, 'откат изменил индекс, ветки, HEAD или статус');
	});

	// The defect this guards: only deletions counted, so edits made in the terminal never offered a rollback of the folder
	test('правка существующего файла без созданных — это изменение, хотя удалять нечего', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const snapshot = await scm.createWorkspaceSnapshot(root);
		assert.ok(snapshot);
		const untouched = await scm.planWorkspaceSnapshotRestore(root, snapshot);

		await put('src/a.ts', 'export const a = "sed -i";\n');
		const edited = await scm.planWorkspaceSnapshotRestore(root, snapshot);

		assert.deepStrictEqual(
			{ untouched: [untouched.delete, untouched.changed], edited: [edited.delete, edited.changed] },
			{ untouched: [[], []], edited: [[], ['src/a.ts']] },
		);
	});

	test('сообщение и подпись снимка соответствуют контракту, ссылка лежит в refs/vibe/checkpoints', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const snapshot = await scm.createWorkspaceSnapshot(root, { turnIndex: 3, threadId: 'thread-9', agent: 'acp-claude', label: 'шаг\n  второй' });
		assert.ok(snapshot);
		const tree = (await git('rev-parse', `${snapshot}^{tree}`)).trim();
		const message = (await git('log', '-1', '--format=%B', snapshot)).trimEnd();
		const who = (await git('log', '-1', '--format=%an <%ae>|%cn <%ce>|%P', snapshot)).trim();
		assert.deepStrictEqual(
			{
				message,
				fields: parseSnapshotCommitMessage(message),
				who,
				ref: (await git('rev-parse', snapshotRefName(snapshot))).trim(),
			},
			{
				message: `VibeIDE checkpoint: ход 3 (agent)\n\ntree: ${tree}\nturnIndex: 3\nthreadId: thread-9\nagent: acp-claude\nlabel: шаг второй`,
				fields: { tree, turnIndex: 3, threadId: 'thread-9', agent: 'acp-claude', label: 'шаг второй' },
				// Parentless, signed by the product and not by user.name / user.email of the repository
				who: 'VibeIDE <snapshot@vibeide.local>|VibeIDE <snapshot@vibeide.local>|',
				ref: snapshot,
			},
		);
	});

	test('ход, ничего не изменивший в папке, возвращает прежний снимок; изменивший — новый', async function () {
		this.timeout(30_000);
		const scm = store.add(new VibeideSCMService());
		const first = await scm.createWorkspaceSnapshot(root, { turnIndex: 0 });
		assert.ok(first);
		const same = await scm.createWorkspaceSnapshot(root, { turnIndex: 1 }, first);
		await put('src/a.ts', 'export const a = 3;\n');
		const next = await scm.createWorkspaceSnapshot(root, { turnIndex: 2 }, first);
		assert.deepStrictEqual([same, next !== first && !!next], [first, true]);
	});
});
