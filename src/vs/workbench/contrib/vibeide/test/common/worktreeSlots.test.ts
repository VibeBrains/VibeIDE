/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { agentWorktreeRootOf, DEFAULT_WORKTREE_SLOT_MAX, DEFAULT_WORKTREE_SLOT_PORTS, formatSlotEnvFile, parseSlotEnvFile, parseSlotFile, pickWorktreeSlot, readSlotOptions, worktreeSlotEnv } from '../../common/worktreeSlots.js';

suite('worktreeSlots — слоты ресурсов рабочих деревьев роли', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('свободный слот — наименьший из свободных', () => {
		assert.deepStrictEqual([
			pickWorktreeSlot([], 9),
			pickWorktreeSlot([1, 2], 9),
			pickWorktreeSlot([1, 3], 9),
			pickWorktreeSlot([1, 2, 3, 4, 5, 6, 7, 8, 9], 9),
		], [1, 3, 2, undefined]);
	});

	test('переменные слота считаются от номера', () => {
		assert.deepStrictEqual(worktreeSlotEnv(3, 'My App', { PORT: 3000, DB_PORT: 5432 }), {
			VIBE_SLOT: '3',
			PORT: '3003',
			DB_PORT: '5435',
			COMPOSE_PROJECT_NAME: 'my-app-slot3',
		});
	});

	test('порт за пределом диапазона пропускается', () => {
		assert.deepStrictEqual(worktreeSlotEnv(3, 'app', { PORT: 3000, TOO_HIGH: 65533 }), {
			VIBE_SLOT: '3',
			PORT: '3003',
			COMPOSE_PROJECT_NAME: 'app-slot3',
		});
	});

	test('файл слота: число, а мусор и ноль — отсутствие слота', () => {
		assert.deepStrictEqual([
			parseSlotFile('4\n'),
			parseSlotFile('x'),
			parseSlotFile('0'),
		], [4, undefined, undefined]);
	});

	test('настройки: неверная форма откатывается к умолчаниям', () => {
		assert.deepStrictEqual([
			readSlotOptions('garbage', 'garbage'),
			readSlotOptions({ port: 1 }, 9),
			readSlotOptions({ PORT: 4000, DB_PORT: 5432 }, 5),
		], [
			{ ports: DEFAULT_WORKTREE_SLOT_PORTS, max: DEFAULT_WORKTREE_SLOT_MAX },
			{ ports: DEFAULT_WORKTREE_SLOT_PORTS, max: 9 },
			{ ports: { PORT: 4000, DB_PORT: 5432 }, max: 5 },
		]);
	});

	test('файл .vibe-slot.env читается обратно тем, что записано, комментарий пропускается', () => {
		const env = worktreeSlotEnv(2, 'app', { PORT: 3000 });
		assert.deepStrictEqual(parseSlotEnvFile(formatSlotEnvFile(env)), env);
	});

	test('корень дерева агента по папке запуска', () => {
		assert.deepStrictEqual([
			agentWorktreeRootOf('/p/.vibe-worktrees/vibe-agent-1/server', '.vibe-worktrees'),
			agentWorktreeRootOf('/p/.vibe-worktrees/vibe-agent-1', '.vibe-worktrees'),
			agentWorktreeRootOf('C:\\p\\.vibe-worktrees\\a\\x', '.vibe-worktrees'),
			agentWorktreeRootOf('/p/src', '.vibe-worktrees'),
			agentWorktreeRootOf('/p/.vibe-worktrees/', '.vibe-worktrees'),
		], ['/p/.vibe-worktrees/vibe-agent-1', '/p/.vibe-worktrees/vibe-agent-1', 'C:\\p\\.vibe-worktrees\\a', undefined, undefined]);
	});
});
