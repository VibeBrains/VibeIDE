/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isSafeBranchName } from './workspaceChangesPolicy.js';

/**
 * От чего ответвляется дерево роли и как его работа возвращается в папку — чистая часть
 *
 * Дерево от `HEAD` не видит незакоммиченных правок пользователя: роль чинит не тот код, который он видит,
 * а проверка в дереве падает на том, что в папке давно исправлено
 * Поэтому база — снимок рабочей папки S, коммит поверх `HEAD`: ветка роли выглядит как HEAD → S → R
 *
 * Слить такую ветку `merge` нельзя: S попал бы в историю, а в папке те же правки остаются незакоммиченными,
 * и слияние упёрлось бы в них же
 * Поэтому работа роли переносится в папку деревом, без коммита — так же, как лежат правки самого пользователя
 */

export type WorktreeBaseMode = 'workingTree' | 'head';

export const WORKTREE_BASE_SETTING = 'vibeide.subagent.worktreeBase';

export const DEFAULT_WORKTREE_BASE: WorktreeBaseMode = 'workingTree';

/** Режим базы из настройки; чужое значение — умолчание. */
export function readWorktreeBaseMode(raw: unknown): WorktreeBaseMode {
	return raw === 'workingTree' || raw === 'head' ? raw : DEFAULT_WORKTREE_BASE;
}

/** Свои ссылки снимков-баз: не видны в `git branch`, не уходят при push и не пересекаются с чекпоинтами. */
export const WORKTREE_BASE_REF_PREFIX = 'refs/vibe/worktree-base';

/** Ссылка базы ветки. Бросает на имени, которое git прочёл бы как опцию или диапазон. */
export function worktreeBaseRef(branch: string): string {
	if (!isSafeBranchName(branch)) {
		throw new Error(`Недопустимое имя ветки дерева: ${branch}`);
	}
	return `${WORKTREE_BASE_REF_PREFIX}/${branch}`;
}

/** Сообщение коммита-базы: его видно в `git log` ветки роли. */
export const WORKTREE_BASE_MESSAGE = 'vibe: рабочие правки на момент старта';

/** Argv (без ведущего `git`). */
export const WORKTREE_BASE_ARGV = {
	headTree: ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'],
	branchExists: (branch: string) => ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
	/** С родителем `HEAD`, а не без родителя, как у чекпоинтов: от бесродительского коммита ветку не вернуть в проект. */
	commitOnHead: (tree: string) => ['commit-tree', tree, '-p', 'HEAD', '-m', WORKTREE_BASE_MESSAGE],
	pin: (branch: string, commit: string) => ['update-ref', worktreeBaseRef(branch), commit],
	resolve: (branch: string) => ['rev-parse', '--verify', '--quiet', `${worktreeBaseRef(branch)}^{commit}`],
	release: (branch: string) => ['update-ref', '-d', worktreeBaseRef(branch)],
	listPins: ['for-each-ref', '--format=%(refname)', WORKTREE_BASE_REF_PREFIX],
	listBranches: ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
	/**
	 * Трёхстороннее слияние деревьев без рабочей папки и без истории
	 * Код выхода 1 — конфликт, и тогда после дерева идут имена конфликтных файлов
	 */
	mergeTrees: (base: string, ours: string, theirs: string) => ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${base}`, ours, theirs],
	/** Без поиска переименований: переносу нужны удалённые и записанные пути, а не их история. */
	changedPaths: (from: string, to: string) => ['diff', '--name-status', '-z', '--no-renames', from, to],
	/** Файлы из временного индекса в папку — только названные, остальные не трогаются. */
	checkoutPaths: (paths: readonly string[]) => ['checkout-index', '-f', '--', ...paths],
} as const;

/**
 * Нужен ли снимок-база
 * Папка совпадает с `HEAD` — снимок ничего не добавил бы, и дерево идёт от `HEAD` с обычным слиянием
 * Без коммитов в репозитории ответвляться не от чего — дерево упадёт на `HEAD`, как и раньше
 */
export function decideWorktreeBase(workingTree: string, headTree: string | undefined): 'head' | 'snapshot' {
	if (!headTree || workingTree.trim() === headTree.trim()) {
		return 'head';
	}
	return 'snapshot';
}

/**
 * Как вернуть в папку работу ветки, ответвлённой от снимка
 * Ветка от `HEAD` (ссылки базы нет) сюда не попадает: она вливается обычным `merge --no-ff`
 */
export type WorktreeFinishStrategy =
	/** Переносить нечего: роль ничего не изменила, или в папке уже ровно её результат */
	| { readonly kind: 'unchanged' }
	/** Папка с начала работы не менялась: её место занимает результат роли */
	| { readonly kind: 'apply'; readonly target: string }
	/** Папка ушла вперёд: правки роли и пользователя сводятся трёхсторонним слиянием от базы */
	| { readonly kind: 'three-way' };

export interface WorktreeFinishInput {
	/** Дерево снимка-базы. */
	readonly baseTree?: string;
	/** Дерево вершины ветки роли. */
	readonly resultTree?: string;
	/** Дерево рабочей папки сейчас. */
	readonly folderTree?: string;
}

/**
 * Решение о переносе
 *
 * Сдвинутый `HEAD` здесь не вход, и это не забывчивость: переносится содержимое, а не история
 * Закоммитил пользователь свои правки — папка та же, и результат ложится как есть
 * Сменил ветку — папка другая, и слияние от базы применит к ней ровно изменения роли или назовёт конфликт
 */
export function decideWorktreeFinish(input: WorktreeFinishInput): WorktreeFinishStrategy {
	const { baseTree, resultTree, folderTree } = input;
	if (!baseTree || !resultTree || !folderTree) {
		throw new Error('Не прочитаны деревья базы, результата или папки — переносить работу вслепую нельзя');
	}
	if (resultTree === baseTree || resultTree === folderTree) {
		return { kind: 'unchanged' };
	}
	if (folderTree === baseTree) {
		return { kind: 'apply', target: resultTree };
	}
	return { kind: 'three-way' };
}

/** Ответ `merge-tree -z --name-only --no-messages`: дерево и конфликтные файлы. */
export interface MergeTreeOutcome {
	readonly tree?: string;
	readonly conflicts: readonly string[];
}

const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Разобрать ответ `merge-tree`
 * Код выхода, а не наличие имён, решает, был ли конфликт: имена без кода 1 — не наш формат, и верить ему нельзя
 */
export function parseMergeTreeZ(stdout: string, exitCode: number): MergeTreeOutcome {
	const [first, ...rest] = stdout.split('\0');
	const tree = first && OBJECT_ID.test(first.trim()) ? first.trim() : undefined;
	if (exitCode === 0) {
		return { ...(tree ? { tree } : {}), conflicts: [] };
	}
	const conflicts = [...new Set(rest.filter(entry => entry.length > 0))];
	return { ...(tree ? { tree } : {}), conflicts: conflicts.length > 0 ? conflicts : ['(git не назвал файлы)'] };
}

/**
 * Ссылки баз, чья ветка исчезла
 * Ветку удалили руками или окно закрылось между снимком и созданием дерева — база держит объекты зря
 */
export function selectOrphanBasePins(pins: readonly string[], branches: readonly string[]): string[] {
	const alive = new Set(branches.map(branch => branch.trim()).filter(Boolean));
	return pins
		.map(pin => pin.trim())
		.filter(pin => pin.startsWith(`${WORKTREE_BASE_REF_PREFIX}/`))
		.filter(pin => !alive.has(pin.slice(WORKTREE_BASE_REF_PREFIX.length + 1)));
}
