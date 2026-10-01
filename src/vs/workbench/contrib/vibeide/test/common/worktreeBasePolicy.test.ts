/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decideWorktreeBase, decideWorktreeFinish, parseMergeTreeZ, readWorktreeBaseMode, selectOrphanBasePins, WORKTREE_BASE_ARGV, worktreeBaseRef,
} from '../../common/worktreeBasePolicy.js';

const BASE = 'a'.repeat(40);
const RESULT = 'b'.repeat(40);
const FOLDER = 'c'.repeat(40);
const MERGED = 'd'.repeat(40);

suite('worktreeBasePolicy — база дерева роли и возврат её работы', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('база: снимок нужен, только когда папка отличается от HEAD', () => {
		assert.deepStrictEqual({
			папкаЧистая: decideWorktreeBase(BASE, BASE),
			естьПравки: decideWorktreeBase(FOLDER, BASE),
			// Без коммитов ответвляться не от чего — дерево упадёт на HEAD, как и раньше
			безКоммитов: decideWorktreeBase(FOLDER, undefined),
			режимПоУмолчанию: readWorktreeBaseMode(undefined),
			режимЯвный: readWorktreeBaseMode('head'),
		}, {
			папкаЧистая: 'head',
			естьПравки: 'snapshot',
			безКоммитов: 'head',
			режимПоУмолчанию: 'workingTree',
			режимЯвный: 'head',
		});
	});

	// База = HEAD сюда не доходит — у такой ветки нет ссылки базы, и она вливается слиянием (см. тест на репозитории)
	test('возврат от снимка: папка не менялась, разошлась, сдвинутый HEAD', () => {
		assert.deepStrictEqual({
			папкаНеМенялась: decideWorktreeFinish({ baseTree: BASE, resultTree: RESULT, folderTree: BASE }),
			папкаРазошлась: decideWorktreeFinish({ baseTree: BASE, resultTree: RESULT, folderTree: FOLDER }),
			// Пользователь закоммитил свои правки: HEAD сдвинулся, а папка та же — решает содержимое, не история
			headСдвинутПапкаТаЖе: decideWorktreeFinish({ baseTree: BASE, resultTree: RESULT, folderTree: BASE }),
			рольНичегоНеИзменила: decideWorktreeFinish({ baseTree: BASE, resultTree: BASE, folderTree: FOLDER }),
			вПапкеУжеРезультат: decideWorktreeFinish({ baseTree: BASE, resultTree: RESULT, folderTree: RESULT }),
		}, {
			папкаНеМенялась: { kind: 'apply', target: RESULT },
			папкаРазошлась: { kind: 'three-way' },
			headСдвинутПапкаТаЖе: { kind: 'apply', target: RESULT },
			рольНичегоНеИзменила: { kind: 'unchanged' },
			вПапкеУжеРезультат: { kind: 'unchanged' },
		});
	});

	test('возврат вслепую невозможен: без деревьев решение не принимается', () => {
		assert.throws(() => decideWorktreeFinish({ baseTree: BASE, resultTree: RESULT }));
	});

	test('merge-tree: код выхода решает, был ли конфликт', () => {
		assert.deepStrictEqual({
			чисто: parseMergeTreeZ(`${MERGED}\0`, 0),
			конфликт: parseMergeTreeZ(`${MERGED}\0src/a.ts\0src/b.ts\0src/a.ts\0\0`, 1),
			конфликтБезИмён: parseMergeTreeZ(`${MERGED}\0`, 1),
		}, {
			чисто: { tree: MERGED, conflicts: [] },
			конфликт: { tree: MERGED, conflicts: ['src/a.ts', 'src/b.ts'] },
			конфликтБезИмён: { tree: MERGED, conflicts: ['(git не назвал файлы)'] },
		});
	});

	test('уборка: снимаются только базы исчезнувших веток', () => {
		assert.deepStrictEqual(selectOrphanBasePins([
			'refs/vibe/worktree-base/vibe-agent-живая',
			'refs/vibe/worktree-base/vibe-agent-удалена',
			'refs/vibe/checkpoints/чужое',
		], ['main', 'vibe-agent-живая']), ['refs/vibe/worktree-base/vibe-agent-удалена']);
	});

	test('argv: база коммитится поверх HEAD, слияние деревьев идёт от базы', () => {
		assert.deepStrictEqual({
			коммит: WORKTREE_BASE_ARGV.commitOnHead(FOLDER),
			закрепить: WORKTREE_BASE_ARGV.pin('vibe-agent-1', RESULT),
			найти: WORKTREE_BASE_ARGV.resolve('vibe-agent-1'),
			слияние: WORKTREE_BASE_ARGV.mergeTrees(BASE, FOLDER, RESULT),
			изменения: WORKTREE_BASE_ARGV.changedPaths(FOLDER, MERGED),
			записать: WORKTREE_BASE_ARGV.checkoutPaths(['src/a.ts']),
		}, {
			коммит: ['commit-tree', FOLDER, '-p', 'HEAD', '-m', 'vibe: рабочие правки на момент старта'],
			закрепить: ['update-ref', 'refs/vibe/worktree-base/vibe-agent-1', RESULT],
			найти: ['rev-parse', '--verify', '--quiet', 'refs/vibe/worktree-base/vibe-agent-1^{commit}'],
			слияние: ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${BASE}`, FOLDER, RESULT],
			изменения: ['diff', '--name-status', '-z', '--no-renames', FOLDER, MERGED],
			записать: ['checkout-index', '-f', '--', 'src/a.ts'],
		});
	});

	test('имя ветки, похожее на опцию или диапазон, в ссылку не попадает', () => {
		assert.throws(() => worktreeBaseRef('--force'));
		assert.throws(() => worktreeBaseRef('a..b'));
	});
});
