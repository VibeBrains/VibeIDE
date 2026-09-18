/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseWorktreeList, worktreeBranchName, worktreeRelativePath } from '../../common/worktreeNaming.js';

suite('worktreeNaming — имена деревьев агента и то, что о них знает git', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Git отвергает пробелы, `~`, `:` и хвостовой `.lock` — ошибка всплыла бы в середине работы. */
	test('идентификатор сессии приводится к имени ветки, которое git примет', () => {
		assert.deepStrictEqual([
			worktreeBranchName('subagent-implement-step-1758100000000-ab12c'),
			worktreeBranchName('Правка: файл ~ 2'),
			worktreeBranchName('..dots..'),
			worktreeBranchName('feature.lock'),
			worktreeBranchName(''),
			worktreeRelativePath('vibe-agent-x'),
		], [
			// Хвост идентификатора обрезан: имя ветки видно в каждом `git branch`.
			'vibe-agent-subagent-implement-step-1758100000000-ab',
			'vibe-agent-правка-файл-2',
			'vibe-agent-dots',
			'vibe-agent-feature.lock'.replace('.lock', 'lock'),
			'vibe-agent-session',
			'.vibe-worktrees/vibe-agent-x',
		]);
	});

	test('вывод git worktree list разбирается: ветка, отсоединённая голова, главное дерево', () => {
		const porcelain = [
			'worktree /repo',
			'HEAD abc123',
			'branch refs/heads/next',
			'',
			'worktree /repo/.vibe-worktrees/vibe-agent-7',
			'HEAD def456',
			'branch refs/heads/vibe-agent-7',
			'',
			'worktree /repo/.vibe-worktrees/detached',
			'HEAD 0099aa',
			'detached',
			'',
		].join('\n');
		assert.deepStrictEqual(parseWorktreeList(porcelain), [
			{ path: '/repo', branch: 'next', detached: false },
			{ path: '/repo/.vibe-worktrees/vibe-agent-7', branch: 'vibe-agent-7', detached: false },
			{ path: '/repo/.vibe-worktrees/detached', detached: true },
		]);
	});
});
