/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import type { PlanStep } from './chatThreadServiceTypes.js';

export interface TaskStep {
	id: string;
	label: string;
	status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
	isRepairStep?: boolean; // Excluded from loop detector
}

export interface TaskDecomposition {
	taskId: string;
	title: string;
	steps: TaskStep[];
	currentStepIndex: number;
}

export const IVibeTaskDecompositionService = createDecorator<IVibeTaskDecompositionService>('vibeTaskDecompositionService');

export interface IVibeTaskDecompositionService {
	readonly _serviceBrand: undefined;
	startTask(title: string, steps: Omit<TaskStep, 'status'>[]): string;
	advanceStep(taskId: string, result: 'done' | 'failed' | 'skipped'): void;
	getTask(taskId: string): TaskDecomposition | undefined;
	readonly onTaskUpdated: Event<TaskDecomposition>;

	/** Mirrors persisted `PlanMessage` steps into decomposition UI (“step N of M”). */
	startPersistedPlanTask(threadId: string, title: string, planSteps: readonly PlanStep[]): void;
	advancePersistedPlanStep(threadId: string, result: 'done' | 'failed' | 'skipped'): void;
	clearPersistedPlanTask(threadId: string): void;
	hasPersistedPlanMirror(threadId: string): boolean;
}

/**
 * VibeIDE Task Decomposition UI.
 * Live progress: 'шаг 3 из 7: пишу тесты'
 * Integration with auto-repair loop (repair steps excluded from loop detector).
 */
class VibeTaskDecompositionService extends Disposable implements IVibeTaskDecompositionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onTaskUpdated = this._register(new Emitter<TaskDecomposition>());
	readonly onTaskUpdated = this._onTaskUpdated.event;

	private readonly _tasks = new Map<string, TaskDecomposition>();
	private readonly _persistedThreadToTask = new Map<string, string>();

	constructor() { super(); }

	private _planStepToUiStatus(s: PlanStep): TaskStep['status'] {
		if (s.disabled) {
			return 'skipped';
		}
		switch (s.status) {
			case 'skipped':
				return 'skipped';
			case 'succeeded':
				return 'done';
			case 'failed':
				return 'failed';
			case 'running':
				return 'running';
			default:
				return 'pending';
		}
	}

	startPersistedPlanTask(threadId: string, title: string, planSteps: readonly PlanStep[]): void {
		const existing = this._persistedThreadToTask.get(threadId);
		if (existing) {
			this._tasks.delete(existing);
			this._persistedThreadToTask.delete(threadId);
		}
		const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const steps: TaskStep[] = planSteps.map(s => ({
			id: `plan-${s.stepNumber}`,
			label: (s.description || `Step ${s.stepNumber}`).trim(),
			status: this._planStepToUiStatus(s),
		}));
		let currentStepIndex = steps.findIndex(st => st.status === 'running');
		if (currentStepIndex < 0) {
			const pend = steps.findIndex(st => st.status === 'pending');
			if (pend >= 0) {
				steps[pend].status = 'running';
				currentStepIndex = pend;
			} else {
				currentStepIndex = Math.max(0, steps.length - 1);
			}
		}
		const task: TaskDecomposition = {
			taskId,
			title,
			steps,
			currentStepIndex,
		};
		this._tasks.set(taskId, task);
		this._persistedThreadToTask.set(threadId, taskId);
		vibeLog.info('TaskDecomp', `Persisted plan mirror: ${title} (${steps.length} steps)`);
		this._onTaskUpdated.fire(task);
	}

	advancePersistedPlanStep(threadId: string, result: 'done' | 'failed' | 'skipped'): void {
		const taskId = this._persistedThreadToTask.get(threadId);
		if (!taskId) {
			return;
		}
		this.advanceStep(taskId, result);
	}

	clearPersistedPlanTask(threadId: string): void {
		const taskId = this._persistedThreadToTask.get(threadId);
		if (!taskId) {
			return;
		}
		this._persistedThreadToTask.delete(threadId);
		this._tasks.delete(taskId);
	}

	hasPersistedPlanMirror(threadId: string): boolean {
		return this._persistedThreadToTask.has(threadId);
	}

	startTask(title: string, steps: Omit<TaskStep, 'status'>[]): string {
		const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
		const task: TaskDecomposition = {
			taskId,
			title,
			steps: steps.map(s => ({ ...s, status: 'pending' })),
			currentStepIndex: 0,
		};
		if (task.steps.length > 0) { task.steps[0].status = 'running'; }
		this._tasks.set(taskId, task);
		vibeLog.info('TaskDecomp', `Started: ${title} (${steps.length} steps)`);
		this._onTaskUpdated.fire(task);
		return taskId;
	}

	advanceStep(taskId: string, result: 'done' | 'failed' | 'skipped'): void {
		const task = this._tasks.get(taskId);
		if (!task) { return; }
		task.steps[task.currentStepIndex].status = result;
		if (task.currentStepIndex < task.steps.length - 1) {
			task.currentStepIndex++;
			task.steps[task.currentStepIndex].status = 'running';
		}
		vibeLog.debug('TaskDecomp', `${task.steps[task.currentStepIndex - 1]?.label}: ${result}`);
		this._onTaskUpdated.fire(task);
	}

	getTask(taskId: string): TaskDecomposition | undefined {
		return this._tasks.get(taskId);
	}
}

registerSingleton(IVibeTaskDecompositionService, VibeTaskDecompositionService, InstantiationType.Eager);
