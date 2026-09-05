/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringSHA1 } from '../../../../../base/common/hash.js';

/**
 * Реестр задач: состояния, переходы и восстановление — чистое ядро, без I/O.
 *
 * WHY a ledger and not a list: a plan inside a chat thread dies with the thread, and an agent that
 * retries a step cannot tell «this already happened» from «this never ran». Work that survives a
 * restart, names what it waits for, and refuses a nonsensical state change is a different thing
 * from a to-do list — and it is the thing an agent loop actually needs.
 *
 * State is DERIVED from an append-only sequence of events rather than stored and mutated. That is
 * what makes the history real: the current state can always be recomputed from the record, and a
 * record that was edited stops adding up.
 *
 * The state machine and the idempotency key are modelled after raytsystem (Apache-2.0,
 * github.com/romarayt/raytsystem-public-os) — its data model, not its code, which is Python.
 */

/**
 * Where a task is in its life.
 *
 * `blocked` is deliberately a state and not a flag: «why is this not moving» must be answerable
 * without reading a description, and a blocked task must not look ready to whoever picks work next.
 */
export type TaskStatus = 'inbox' | 'planned' | 'ready' | 'running' | 'review' | 'blocked' | 'done' | 'cancelled';

export type TaskEventKind = 'created' | 'transitioned' | 'cancelled';

export interface Task {
	readonly id: string;
	readonly title: string;
	readonly status: TaskStatus;
	/** Tasks that must reach `done` before this one may start. */
	readonly dependencyIds: readonly string[];
	/** Why it is blocked, when it is — a field, so it survives and can be shown rather than guessed. */
	readonly blockedReason?: string;
	/** Who asked for the work: a person, the agent, a subagent role. */
	readonly createdBy: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	/** Increments on every accepted change — a cheap optimistic-locking token for the UI. */
	readonly revision: number;
}

export interface TaskEvent {
	readonly kind: TaskEventKind;
	readonly taskId: string;
	readonly at: number;
	readonly actor: string;
	/**
	 * Identifies the OPERATION, not the event.
	 *
	 * A retried command carries the same key and must not produce a second task or a second
	 * transition. Without it, every hiccup in an agent loop leaves a duplicate behind.
	 */
	readonly operationKey: string;
	readonly to: TaskStatus;
	readonly from?: TaskStatus;
	/** Present on `created`: the fields the task starts with. */
	readonly task?: Pick<Task, 'title' | 'dependencyIds' | 'createdBy'>;
	readonly blockedReason?: string;
}

/**
 * Which state changes are legal.
 *
 * An explicit table rather than a chain of conditions: the set of legal moves is the contract of the
 * ledger and should be readable at a glance. `done` and `cancelled` are terminal on purpose —
 * reopening is a new task with its own history, not a rewrite of a finished one.
 */
export const ALLOWED_TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map<TaskStatus, ReadonlySet<TaskStatus>>([
	['inbox', new Set<TaskStatus>(['planned', 'cancelled'])],
	['planned', new Set<TaskStatus>(['ready', 'blocked', 'cancelled'])],
	['ready', new Set<TaskStatus>(['running', 'blocked', 'cancelled'])],
	['running', new Set<TaskStatus>(['review', 'blocked', 'cancelled'])],
	['review', new Set<TaskStatus>(['done', 'running', 'blocked', 'cancelled'])],
	['blocked', new Set<TaskStatus>(['planned', 'ready', 'running', 'cancelled'])],
	['done', new Set<TaskStatus>()],
	['cancelled', new Set<TaskStatus>()],
]);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
	return ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;
}

/** Tasks a task is waiting for: dependencies that are neither done nor cancelled. */
export function blockingDependencies(task: Task, byId: ReadonlyMap<string, Task>): string[] {
	return task.dependencyIds.filter(id => {
		const dependency = byId.get(id);
		// An unknown dependency blocks. It is likelier to be a task not created yet than a typo, and
		// starting work that waits on something nobody can see is the worse failure.
		return !dependency || (dependency.status !== 'done' && dependency.status !== 'cancelled');
	});
}

/**
 * A cycle among dependencies, if there is one.
 *
 * Cycles are not hypothetical: two tasks each waiting for the other is an easy thing to type, and
 * without this the reader is left wondering why neither ever becomes ready.
 */
export function dependencyCycle(tasks: readonly Task[]): string[] | undefined {
	const byId = new Map(tasks.map(task => [task.id, task]));
	const state = new Map<string, 'visiting' | 'done'>();
	const stack: string[] = [];

	const walk = (id: string): string[] | undefined => {
		const mark = state.get(id);
		if (mark === 'done') {
			return undefined;
		}
		if (mark === 'visiting') {
			// The cycle is the part of the stack from where this id was met the first time.
			return [...stack.slice(stack.indexOf(id)), id];
		}
		state.set(id, 'visiting');
		stack.push(id);
		for (const dependencyId of byId.get(id)?.dependencyIds ?? []) {
			const found = walk(dependencyId);
			if (found) {
				return found;
			}
		}
		stack.pop();
		state.set(id, 'done');
		return undefined;
	};

	for (const task of tasks) {
		const found = walk(task.id);
		if (found) {
			return found;
		}
	}
	return undefined;
}

/**
 * Stable key of an operation: the same command with the same arguments yields the same key.
 *
 * The caller supplies its own `intent` — a retry must reuse it, and two genuinely different requests
 * must not collide. Hashed with the same primitive as the audit chain: one way of hashing in the
 * product, not two.
 */
export function operationKeyOf(command: string, intent: string, payload: unknown): string {
	const sha = new StringSHA1();
	sha.update(`${command} ${intent} ${JSON.stringify(payload ?? null)}`);
	return sha.digest();
}

export type LedgerRejection =
	| { readonly reason: 'unknown-task'; readonly taskId: string }
	| { readonly reason: 'illegal-transition'; readonly from: TaskStatus; readonly to: TaskStatus }
	| { readonly reason: 'duplicate-task'; readonly taskId: string };

/**
 * Fold one event into the register.
 *
 * Returns the rejection instead of throwing when an event does not fit: replaying a journal must
 * report a broken record and keep going, not die on line 400 of someone's history.
 */
export function applyEvent(tasks: ReadonlyMap<string, Task>, event: TaskEvent): { tasks: Map<string, Task>; rejected?: LedgerRejection } {
	const next = new Map(tasks);
	const existing = next.get(event.taskId);

	if (event.kind === 'created') {
		if (existing) {
			return { tasks: next, rejected: { reason: 'duplicate-task', taskId: event.taskId } };
		}
		next.set(event.taskId, {
			id: event.taskId,
			title: event.task?.title ?? event.taskId,
			status: event.to,
			dependencyIds: event.task?.dependencyIds ?? [],
			createdBy: event.task?.createdBy ?? event.actor,
			createdAt: event.at,
			updatedAt: event.at,
			revision: 1,
		});
		return { tasks: next };
	}

	if (!existing) {
		return { tasks: next, rejected: { reason: 'unknown-task', taskId: event.taskId } };
	}
	if (!canTransition(existing.status, event.to)) {
		return { tasks: next, rejected: { reason: 'illegal-transition', from: existing.status, to: event.to } };
	}
	next.set(event.taskId, {
		...existing,
		status: event.to,
		// The reason belongs to the blocked state and must not outlive it, or a running task keeps
		// explaining why it was once stuck.
		blockedReason: event.to === 'blocked' ? event.blockedReason : undefined,
		updatedAt: event.at,
		revision: existing.revision + 1,
	});
	return { tasks: next };
}

export interface ReplayResult {
	readonly tasks: Map<string, Task>;
	/** Events that did not fit, with their position — reported, never silently dropped. */
	readonly rejected: readonly { readonly index: number; readonly rejection: LedgerRejection }[];
	/** Operation keys already seen: what makes a retry a no-op rather than a duplicate. */
	readonly operationKeys: Set<string>;
}

/** Rebuild the register from its journal, in order. */
export function replayEvents(events: readonly TaskEvent[]): ReplayResult {
	let tasks: Map<string, Task> = new Map();
	const rejected: { index: number; rejection: LedgerRejection }[] = [];
	const operationKeys = new Set<string>();

	for (const [index, event] of events.entries()) {
		// A repeated operation key is a retry that already landed; applying it again would double it.
		if (operationKeys.has(event.operationKey)) {
			continue;
		}
		const result = applyEvent(tasks, event);
		tasks = result.tasks;
		if (result.rejected) {
			rejected.push({ index, rejection: result.rejected });
			continue;
		}
		operationKeys.add(event.operationKey);
	}
	return { tasks, rejected, operationKeys };
}
