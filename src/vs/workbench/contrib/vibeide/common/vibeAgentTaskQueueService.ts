/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface QueuedTask {
	id: string;
	description: string;
	status: TaskStatus;
	addedAt: number;
	startedAt?: number;
	completedAt?: number;
	dmsTimeoutMinutes?: number; // Per-task DMS override
}

export const IVibeAgentTaskQueueService = createDecorator<IVibeAgentTaskQueueService>('vibeAgentTaskQueueService');

export interface IVibeAgentTaskQueueService {
	readonly _serviceBrand: undefined;

	/** Add task to queue */
	enqueue(task: Omit<QueuedTask, 'id' | 'status' | 'addedAt'>): string;

	/** Get all tasks (ordered by queue position) */
	getTasks(): QueuedTask[];

	/** Cancel a specific task */
	cancel(taskId: string): void;

	/** Clear all queued tasks */
	clearQueue(): void;

	/** Get currently running task */
	getCurrentTask(): QueuedTask | null;

	/** Advance first queued task to running (sequential runner). No-op if one is already running. */
	startNextQueued(): QueuedTask | null;

	/** Mark running task finished */
	completeCurrent(finalStatus: 'completed' | 'failed'): QueuedTask | null;

	readonly onTaskStatusChanged: Event<QueuedTask>;
}

/**
 * VibeIDE Agent Task Queue.
 * User queues N tasks in advance; agent executes sequentially.
 * Each task has its own DMS timeout.
 */
class VibeAgentTaskQueueService extends Disposable implements IVibeAgentTaskQueueService {
	declare readonly _serviceBrand: undefined;

	private readonly _onTaskStatusChanged = this._register(new Emitter<QueuedTask>());
	readonly onTaskStatusChanged = this._onTaskStatusChanged.event;

	private readonly _tasks: QueuedTask[] = [];

	constructor(
	) {
		super();
	}

	enqueue(task: Omit<QueuedTask, 'id' | 'status' | 'addedAt'>): string {
		const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const queued: QueuedTask = {
			...task,
			id,
			status: 'queued',
			addedAt: Date.now(),
		};
		this._tasks.push(queued);
		this._onTaskStatusChanged.fire(queued);
		vibeLog.debug('TaskQueue', `Queued: ${task.description.slice(0, 60)}`);
		return id;
	}

	getTasks(): QueuedTask[] {
		return [...this._tasks];
	}

	cancel(taskId: string): void {
		const task = this._tasks.find(t => t.id === taskId);
		if (!task) { return; }
		if (task.status === 'running' || task.status === 'queued') {
			task.status = 'cancelled';
			this._onTaskStatusChanged.fire(task);
			vibeLog.debug('TaskQueue', `Cancelled: ${task.description.slice(0, 40)}`);
		}
	}

	clearQueue(): void {
		const queued = this._tasks.filter(t => t.status === 'queued');
		queued.forEach(t => { t.status = 'cancelled'; this._onTaskStatusChanged.fire(t); });
		vibeLog.debug('TaskQueue', `Cleared ${queued.length} queued tasks`);
	}

	getCurrentTask(): QueuedTask | null {
		return this._tasks.find(t => t.status === 'running') ?? null;
	}

	startNextQueued(): QueuedTask | null {
		if (this._tasks.some(t => t.status === 'running')) {
			return null;
		}
		const next = this._tasks.find(t => t.status === 'queued');
		if (!next) {
			return null;
		}
		next.status = 'running';
		next.startedAt = Date.now();
		this._onTaskStatusChanged.fire(next);
		vibeLog.debug('TaskQueue', `Running: ${next.description.slice(0, 60)}`);
		return next;
	}

	completeCurrent(finalStatus: 'completed' | 'failed'): QueuedTask | null {
		const cur = this.getCurrentTask();
		if (!cur) {
			return null;
		}
		cur.status = finalStatus;
		cur.completedAt = Date.now();
		this._onTaskStatusChanged.fire(cur);
		vibeLog.debug('TaskQueue', `${finalStatus}: ${cur.description.slice(0, 40)}`);
		return cur;
	}
}

registerSingleton(IVibeAgentTaskQueueService, VibeAgentTaskQueueService, InstantiationType.Eager);
