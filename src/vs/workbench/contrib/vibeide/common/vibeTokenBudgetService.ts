/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { IVibeAgentTaskQueueService } from './vibeAgentTaskQueueService.js';

export interface TokenBudgetStatus {
	sessionTokensUsed: number;
	sessionTokensLimit: number;
	percentUsed: number;
	isExceeded: boolean;
	isWarning: boolean; // >80% used
}

export const IVibeTokenBudgetService = createDecorator<IVibeTokenBudgetService>('vibeTokenBudgetService');

export interface IVibeTokenBudgetService {
	readonly _serviceBrand: undefined;

	/** Current session token usage status */
	getStatus(): TokenBudgetStatus;

	/** Record token usage from an LLM response */
	recordUsage(inputTokens: number, outputTokens: number): void;

	/** Check if budget is exceeded — throws if so */
	checkBudget(): void;

	/** Reset session token counter (new session) */
	resetSession(): void;

	/**
	 * When task-queue token split is enabled: attribute usage to this queued/running task id.
	 * Cleared automatically when the task reaches a terminal status (via task queue events).
	 * Integrations (agent runner) may override explicitly.
	 */
	setActiveQueueTaskId(taskId: string | undefined): void;

	/** Event fired when budget status changes */
	readonly onBudgetStatusChanged: Event<TokenBudgetStatus>;
}

/**
 * VibeIDE: Session token budget enforcement.
 * Default limit: 500,000 tokens per session.
 * Prevents runaway agents from generating unexpected costs.
 */
class VibeTokenBudgetService extends Disposable implements IVibeTokenBudgetService {
	declare readonly _serviceBrand: undefined;

	private readonly _onBudgetStatusChanged = this._register(new Emitter<TokenBudgetStatus>());
	readonly onBudgetStatusChanged = this._onBudgetStatusChanged.event;

	private _sessionTokensUsed = 0;
	private _sessionTokensLimit: number;
	private _enabled: boolean;
	private _splitEnabled: boolean;

	private _activeQueueTaskId: string | undefined;
	private readonly _perTaskTokens = new Map<string, number>();

	// Default: 500k tokens per session (~$20 at average pricing)
	private static readonly DEFAULT_TOKEN_LIMIT = 500_000;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ILogService private readonly _logService: ILogService,
		@IVibeAgentTaskQueueService private readonly _taskQueue: IVibeAgentTaskQueueService,
	) {
		super();
		this._sessionTokensLimit = this._configurationService.getValue<number>('vibeide.safety.sessionTokenLimit')
			?? VibeTokenBudgetService.DEFAULT_TOKEN_LIMIT;
		this._enabled = this._configurationService.getValue<boolean>('vibeide.safety.sessionTokenLimitEnabled')
			?? true;
		this._splitEnabled = this._configurationService.getValue<boolean>('vibeide.safety.taskQueueTokenSplitEnabled')
			?? false;

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.sessionTokenLimit') || e.affectsConfiguration('vibeide.safety.sessionTokenLimitEnabled')) {
				this._sessionTokensLimit = this._configurationService.getValue<number>('vibeide.safety.sessionTokenLimit')
					?? VibeTokenBudgetService.DEFAULT_TOKEN_LIMIT;
				this._enabled = this._configurationService.getValue<boolean>('vibeide.safety.sessionTokenLimitEnabled')
					?? true;
			}
			if (e.affectsConfiguration('vibeide.safety.taskQueueTokenSplitEnabled')) {
				this._splitEnabled = this._configurationService.getValue<boolean>('vibeide.safety.taskQueueTokenSplitEnabled')
					?? false;
			}
		}));

		this._register(this._taskQueue.onTaskStatusChanged(t => {
			if (t.status === 'running') {
				this._activeQueueTaskId = t.id;
			}
			if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') {
				this._perTaskTokens.delete(t.id);
				if (this._activeQueueTaskId === t.id) {
					this._activeQueueTaskId = undefined;
				}
			}
		}));
	}

	setActiveQueueTaskId(taskId: string | undefined): void {
		this._activeQueueTaskId = taskId;
	}

	getStatus(): TokenBudgetStatus {
		const percentUsed = this._sessionTokensLimit > 0
			? (this._sessionTokensUsed / this._sessionTokensLimit) * 100
			: 0;
		return {
			sessionTokensUsed: this._sessionTokensUsed,
			sessionTokensLimit: this._sessionTokensLimit,
			percentUsed,
			isExceeded: this._enabled && this._sessionTokensUsed >= this._sessionTokensLimit,
			isWarning: this._enabled && percentUsed >= 80,
		};
	}

	recordUsage(inputTokens: number, outputTokens: number): void {
		const total = Math.max(0, inputTokens) + Math.max(0, outputTokens);
		this._sessionTokensUsed += total;

		if (this._splitEnabled && this._activeQueueTaskId && total > 0) {
			const id = this._activeQueueTaskId;
			this._perTaskTokens.set(id, (this._perTaskTokens.get(id) ?? 0) + total);
		}

		this._logService.debug(`[VibeIDE TokenBudget] +${total} tokens (in:${inputTokens} out:${outputTokens}) | total: ${this._sessionTokensUsed}/${this._sessionTokensLimit}`);

		const status = this.getStatus();
		this._onBudgetStatusChanged.fire(status);

		if (status.isWarning && !status.isExceeded) {
			this._logService.warn(`[VibeIDE TokenBudget] ⚠️ Warning: ${status.percentUsed.toFixed(0)}% of session token limit used (${this._sessionTokensUsed.toLocaleString()}/${this._sessionTokensLimit.toLocaleString()})`);
		}
	}

	checkBudget(): void {
		if (!this._enabled) return;
		const status = this.getStatus();
		if (status.isExceeded) {
			throw new Error(
				localize(
					'vibeTokenBudgetExceeded',
					'Session token limit reached ({0} tokens used, limit: {1}). To continue, reset the session or increase the limit in Settings → VibeIDE → Safety.',
					this._sessionTokensUsed.toLocaleString(),
					this._sessionTokensLimit.toLocaleString()
				)
			);
		}

		if (this._splitEnabled && this._activeQueueTaskId) {
			const sliceCount = this._taskQueue.getTasks().filter(t => t.status === 'queued' || t.status === 'running').length;
			if (sliceCount >= 2) {
				const perLimit = Math.max(1, Math.floor(this._sessionTokensLimit / sliceCount));
				const usedSlice = this._perTaskTokens.get(this._activeQueueTaskId) ?? 0;
				if (usedSlice >= perLimit) {
					throw new Error(
						localize(
							'vibeTokenBudgetSliceExceeded',
							'Token budget slice for this task is exhausted (~{0} tokens per task while {1} tasks are queued or running). Finish or cancel queued tasks, disable task queue split in Settings, or raise the session limit.',
							perLimit.toLocaleString(),
							String(sliceCount)
						)
					);
				}
			}
		}
	}

	resetSession(): void {
		const prev = this._sessionTokensUsed;
		this._sessionTokensUsed = 0;
		this._perTaskTokens.clear();
		this._activeQueueTaskId = undefined;
		this._logService.info(`[VibeIDE TokenBudget] Session reset. Previous usage: ${prev.toLocaleString()} tokens`);
		this._onBudgetStatusChanged.fire(this.getStatus());
	}
}

registerSingleton(IVibeTokenBudgetService, VibeTokenBudgetService, InstantiationType.Eager);
