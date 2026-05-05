/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVibeCheckpointCoordinator } from './vibeCheckpointCoordinatorService.js';
import { IVibeGitWorktreeService } from './vibeGitWorktreeService.js';

export interface AgentInstance {
	id: string;
	role: 'architect' | 'coder' | 'reviewer';
	sessionId: string;
	worktreeId?: string;
	status: 'idle' | 'running' | 'complete';
}

export const IVibeMultiAgentService = createDecorator<IVibeMultiAgentService>('vibeMultiAgentService');

export interface IVibeMultiAgentService {
	readonly _serviceBrand: undefined;

	/** Start multi-agent session (Architect + Coder) */
	startSession(task: string): Promise<string>;

	/** Active agent rows mirrored from **`IVibeGitWorktreeService`** (agent worktrees only) */
	getAgents(): AgentInstance[];

	/** Checkpoint mutex: create checkpoint safely across agents */
	createCheckpoint(label: string): Promise<string>;
}

/**
 * VibeIDE Multi-agent Mode.
 * Architect plans, Coder implements in parallel git worktrees.
 *
 * KEY: checkpoint mutex from Фаза 0 decisions is required.
 * This is the Phase 3b high-complexity feature.
 * Phase 1: skeleton service. Phase 3b: full implementation.
 */
class VibeMultiAgentService extends Disposable implements IVibeMultiAgentService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IVibeCheckpointCoordinator private readonly _checkpointCoordinator: IVibeCheckpointCoordinator,
		@IVibeGitWorktreeService private readonly _worktreeService: IVibeGitWorktreeService,
	) {
		super();
	}

	async startSession(task: string): Promise<string> {
		const sessionId = `multi-${Date.now()}`;
		const wt = await this._worktreeService.createAgentWorktree(sessionId);
		if (wt) {
			this._logService.info(`[VibeIDE MultiAgent] Session ${sessionId} — worktree ${wt.id} (${wt.branch}) for task prefix: ${task.slice(0, 50)}`);
		} else {
			this._logService.warn(`[VibeIDE MultiAgent] Session ${sessionId} started without worktree (stub failure)`);
		}
		return sessionId;
	}

	getAgents(): AgentInstance[] {
		return this._worktreeService
			.getWorktrees()
			.filter(w => w.isAgentWorktree)
			.map(w => ({
				id: `agent:${w.id}`,
				role: 'coder',
				sessionId: w.sessionId ?? w.id,
				worktreeId: w.id,
				status: 'running',
			}));
	}

	async createCheckpoint(label: string): Promise<string> {
		return this._checkpointCoordinator.runExclusive({ op: 'multiagent:createCheckpoint', holderLabel: label }, async () => {
			const id = `checkpoint-${Date.now()}`;
			this._logService.debug(`[VibeIDE MultiAgent] Checkpoint: ${label}`);
			return id;
		});
	}
}

registerSingleton(IVibeMultiAgentService, VibeMultiAgentService, InstantiationType.Delayed);
