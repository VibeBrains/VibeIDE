/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	blockingDependencies, canTransition, dependencyCycle, operationKeyOf, replayEvents,
	Task, TaskEvent, TaskStatus,
} from '../../common/taskLedger/taskModel.js';

/**
 * The task ledger's core rules.
 *
 * Each test fixes a failure that costs something real: a state change that should have been refused,
 * a retry that would have created a second task, work that would have started while waiting for
 * something, or a history that stops adding up.
 */
suite('task ledger model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const event = (over: Partial<TaskEvent> & Pick<TaskEvent, 'kind' | 'taskId' | 'to'>): TaskEvent => ({
		at: 1, actor: 'human', operationKey: `op-${over.taskId}-${over.to}`, ...over,
	});
	const created = (id: string, title = id, dependencyIds: string[] = []): TaskEvent =>
		event({ kind: 'created', taskId: id, to: 'inbox', task: { title, dependencyIds, createdBy: 'human' } });
	const moved = (id: string, to: TaskStatus, over: Partial<TaskEvent> = {}): TaskEvent =>
		event({ kind: 'transitioned', taskId: id, to, ...over });

	test('the transition table is the contract, and terminal states are terminal', () => {
		assert.deepStrictEqual({
			вперёд: canTransition('planned', 'ready'),
			черезГолову: canTransition('inbox', 'running'),
			изЗаблокированной: canTransition('blocked', 'running'),
			возвратИзРевью: canTransition('review', 'running'),
			изЗавершённой: canTransition('done', 'running'),
			изОтменённой: canTransition('cancelled', 'planned'),
		}, {
			вперёд: true,
			// Skipping states would let work start that nobody planned.
			черезГолову: false,
			изЗаблокированной: true,
			возвратИзРевью: true,
			// Reopening is a new task with its own history, not a rewrite of a finished one.
			изЗавершённой: false,
			изОтменённой: false,
		});
	});

	test('an illegal transition is refused and named, and the task keeps its state', () => {
		const { tasks, rejected } = replayEvents([created('a'), moved('a', 'running')]);
		assert.strictEqual(tasks.get('a')?.status, 'inbox');
		assert.deepStrictEqual(rejected, [{ index: 1, rejection: { reason: 'illegal-transition', from: 'inbox', to: 'running' } }]);
	});

	/**
	 * The reason a ledger exists rather than a list: an agent that retries a command must not create
	 * a second task. The retry carries the same operation key, so it is a no-op — not a duplicate.
	 */
	test('a retried operation changes nothing', () => {
		const create = created('a', 'Собрать релиз');
		const { tasks, operationKeys } = replayEvents([create, { ...create, at: 2 }, moved('a', 'planned'), moved('a', 'planned')]);
		assert.deepStrictEqual({ tasks: tasks.size, status: tasks.get('a')?.status, revision: tasks.get('a')?.revision, keys: operationKeys.size }, {
			tasks: 1, status: 'planned', revision: 2, keys: 2,
		});
	});

	test('history adds up: state is recomputed from the events, not stored', () => {
		const { tasks } = replayEvents([
			created('a'), moved('a', 'planned'), moved('a', 'ready'), moved('a', 'running'),
			moved('a', 'blocked', { blockedReason: 'ждёт ключ API', operationKey: 'op-block' }),
			moved('a', 'running', { operationKey: 'op-unblock' }),
		]);
		const task = tasks.get('a')!;
		assert.deepStrictEqual({ status: task.status, revision: task.revision, reason: task.blockedReason }, {
			status: 'running',
			revision: 6,
			// The reason belongs to the blocked state: a running task must not keep explaining it.
			reason: undefined,
		});
	});

	test('a transition of a task that does not exist is reported, not applied', () => {
		const { tasks, rejected } = replayEvents([moved('ghost', 'planned')]);
		assert.strictEqual(tasks.size, 0);
		assert.deepStrictEqual(rejected, [{ index: 0, rejection: { reason: 'unknown-task', taskId: 'ghost' } }]);
	});

	test('waiting is computed, and an unknown dependency counts as waiting', () => {
		const { tasks } = replayEvents([
			created('base'), created('leaf', 'leaf', ['base', 'missing']),
			moved('base', 'planned'), moved('base', 'ready'), moved('base', 'running'),
			moved('base', 'review'), moved('base', 'done'),
		]);
		const leaf = tasks.get('leaf')!;
		// `base` is finished; `missing` was never created — likelier a task not yet written down than
		// a typo, and starting work that waits on something invisible is the worse failure.
		assert.deepStrictEqual(blockingDependencies(leaf, tasks), ['missing']);
	});

	test('a cancelled dependency stops blocking', () => {
		const { tasks } = replayEvents([created('base'), created('leaf', 'leaf', ['base']), moved('base', 'cancelled')]);
		assert.deepStrictEqual(blockingDependencies(tasks.get('leaf')!, tasks), []);
	});

	/** Two tasks waiting for each other never become ready; the reader deserves to be told why. */
	test('a dependency cycle is found and named', () => {
		const task = (id: string, dependencyIds: string[]): Task =>
			({ id, title: id, status: 'planned', dependencyIds, createdBy: 'human', createdAt: 0, updatedAt: 0, revision: 1 });
		assert.deepStrictEqual(dependencyCycle([task('a', ['b']), task('b', ['a'])]), ['a', 'b', 'a']);
		assert.strictEqual(dependencyCycle([task('a', ['b']), task('b', [])]), undefined);
		assert.strictEqual(dependencyCycle([task('a', ['missing'])]), undefined, 'отсутствующая зависимость — не цикл');
	});

	test('the operation key depends on the arguments and not on anything else', () => {
		const first = operationKeyOf('create', 'intent-1', { title: 'a' });
		assert.strictEqual(first, operationKeyOf('create', 'intent-1', { title: 'a' }), 'повтор той же операции даёт тот же ключ');
		assert.notStrictEqual(first, operationKeyOf('create', 'intent-2', { title: 'a' }));
		assert.notStrictEqual(first, operationKeyOf('create', 'intent-1', { title: 'b' }));
		assert.notStrictEqual(first, operationKeyOf('transition', 'intent-1', { title: 'a' }));
	});
});
