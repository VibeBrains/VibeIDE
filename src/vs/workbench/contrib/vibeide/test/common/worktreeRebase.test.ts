/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { rebaseIntoWorktree, rebaseParamsIntoWorktree, relativeToRoot } from '../../common/worktreeRebase.js';
import { URI } from '../../../../../base/common/uri.js';

const ROOT = '/repo';
const TREE = '/repo/.vibe-worktrees/vibe-agent-7';

suite('worktreeRebase — пути прогона в его рабочем дереве', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('переносится путь под корнем, и только он', () => {
		assert.deepStrictEqual({
			подКорнем: rebaseIntoWorktree(ROOT, TREE, '/repo/src/app.ts'),
			// Дерево лежит внутри рабочей области, поэтому повторный перенос загнал бы файл
			// в дерево внутри дерева.
			ужеВДереве: rebaseIntoWorktree(ROOT, TREE, `${TREE}/src/app.ts`),
			// Наружу ведут заранее разрешённые пользователем папки — их утаскивать нельзя.
			снаружи: rebaseIntoWorktree(ROOT, TREE, '/other/notes.md'),
			самКорень: rebaseIntoWorktree(ROOT, TREE, '/repo'),
			// Изоляции нет — путь остаётся каким был.
			безДерева: rebaseIntoWorktree(ROOT, '', '/repo/src/app.ts'),
		}, {
			подКорнем: '/repo/.vibe-worktrees/vibe-agent-7/src/app.ts',
			ужеВДереве: `${TREE}/src/app.ts`,
			снаружи: '/other/notes.md',
			самКорень: '/repo/.vibe-worktrees/vibe-agent-7',
			безДерева: '/repo/src/app.ts',
		});
	});

	test('разделители и регистр: Windows совпадает, Linux — нет', () => {
		assert.deepStrictEqual({
			обратныеКосые: rebaseIntoWorktree('C:\\repo', 'C:\\repo\\.vibe-worktrees\\t', 'C:\\repo\\src\\app.ts', true),
			другойРегистр: rebaseIntoWorktree('C:/repo', 'C:/repo/.vibe-worktrees/t', 'c:/REPO/src/app.ts', true),
			// На Linux `/REPO` — другой каталог, а не тот же самый: переносить нечего.
			регистрЗначим: rebaseIntoWorktree(ROOT, TREE, '/REPO/src/app.ts'),
		}, {
			обратныеКосые: 'C:/repo/.vibe-worktrees/t/src/app.ts',
			другойРегистр: 'C:/repo/.vibe-worktrees/t/src/app.ts',
			регистрЗначим: '/REPO/src/app.ts',
		});
	});

	test('параметры вызова: пути уезжают в дерево на любой глубине', () => {
		const результат = rebaseParamsIntoWorktree({
			uri: URI.file('/repo/src/app.ts'),
			список: [URI.file('/repo/docs/a.md'), URI.file('/other/b.md')],
			// Вложенный путь — тот же путь: оставь его на месте, роль записала бы в общую папку
			// через один лишний уровень вложенности.
			вложенный: { глубже: { uri: URI.file('/repo/src/deep.ts') } },
			число: 42,
		}, ROOT, TREE) as Record<string, any>;
		assert.deepStrictEqual({
			верхний: результат['uri'].fsPath,
			вСписке: результат['список'].map((u: URI) => u.fsPath),
			вложенный: результат['вложенный'].глубже.uri.fsPath,
			неПуть: результат['число'],
		}, {
			верхний: `${TREE}/src/app.ts`,
			вСписке: [`${TREE}/docs/a.md`, '/other/b.md'],
			вложенный: `${TREE}/src/deep.ts`,
			неПуть: 42,
		});
	});

	test('папка команды оболочки — дерево прогона, а не открытая папка', () => {
		const cwdOf = (cwd: unknown): unknown => (rebaseParamsIntoWorktree({ command: 'npm test', cwd }, ROOT, TREE) as { cwd?: unknown }).cwd;
		assert.deepStrictEqual({
			// Умолчание терминала — открытая папка, то есть сборка роли шла бы мимо её дерева.
			пусто: cwdOf(null),
			относительный: cwdOf('packages/api'),
			абсолютный: cwdOf('/repo/packages/api'),
			снаружи: cwdOf('/other/api'),
		}, {
			пусто: TREE,
			относительный: `${TREE}/packages/api`,
			абсолютный: `${TREE}/packages/api`,
			снаружи: '/other/api',
		});
	});

	test('путь относительно корня — тем же правилом, каким его меряет граница записи', () => {
		assert.deepStrictEqual({
			вДереве: relativeToRoot(TREE, `${TREE}/src/app.ts`),
			вРабочейОбласти: relativeToRoot(ROOT, '/repo/docs/guide.md'),
			// Назвать чужой путь относительным значило бы соврать о том, где он лежит.
			снаружи: relativeToRoot(ROOT, '/other/notes.md'),
			самКорень: relativeToRoot(ROOT, '/repo'),
			хвостоваяКосая: relativeToRoot('/repo/', '/repo/src/app.ts'),
		}, {
			вДереве: 'src/app.ts',
			вРабочейОбласти: 'docs/guide.md',
			снаружи: '/other/notes.md',
			самКорень: '',
			хвостоваяКосая: 'src/app.ts',
		});
	});
});
