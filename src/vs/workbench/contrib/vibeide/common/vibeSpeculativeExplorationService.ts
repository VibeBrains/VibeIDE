/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeGitWorktreeService, WorktreeInfo } from './vibeGitWorktreeService.js';

export interface ExplorationBranch {
	id: string;
	worktree: WorktreeInfo;
	approach: string;
	status: 'running' | 'complete' | 'abandoned';
}

export const IVibeSpeculativeExplorationService = createDecorator<IVibeSpeculativeExplorationService>('vibeSpeculativeExplorationService');

export interface IVibeSpeculativeExplorationService {
	readonly _serviceBrand: undefined;

	/** Start parallel exploration of two approaches */
	startExploration(task: string, approaches: [string, string]): Promise<string>;

	/** Get both exploration branches */
	getBranches(explorationId: string): ExplorationBranch[];

	/** User selects preferred approach — abandons the other */
	selectBranch(explorationId: string, branchId: string): Promise<void>;
}

/**
 * VibeIDE Speculative Parallel Exploration (Phase 3b).
 * Agent tries two approaches in parallel in isolated git worktrees.
 * User sees side-by-side diff and selects the better one.
 *
 * Requires: Git Worktree Isolation + Multi-agent (checkpoint mutex).
 */
class VibeSpeculativeExplorationService extends Disposable implements IVibeSpeculativeExplorationService {
	declare readonly _serviceBrand: undefined;

	private readonly _explorations = new Map<string, ExplorationBranch[]>();

	constructor(
		@IVibeGitWorktreeService private readonly _worktreeService: IVibeGitWorktreeService,
	) {
		super();
	}

	async startExploration(task: string, approaches: [string, string]): Promise<string> {
		const explorationId = `explore-${Date.now()}`;
		vibeLog.info('Speculation', `Starting parallel exploration: "${task.slice(0, 40)}"`);

		// Phase 3b: create two worktrees and run agents in parallel
		const branches: ExplorationBranch[] = [];
		const raw = await this._worktreeService.createMultipleAgentWorktrees(explorationId, ['0', '1']);
		for (const [i, approach] of approaches.entries()) {
			const wt = raw[i];
			if (wt) {
				branches.push({ id: `branch-${i}`, worktree: wt, approach, status: 'running' });
			}
		}
		this._explorations.set(explorationId, branches);
		return explorationId;
	}

	getBranches(explorationId: string): ExplorationBranch[] {
		return this._explorations.get(explorationId) ?? [];
	}

	async selectBranch(explorationId: string, branchId: string): Promise<void> {
		const branches = this._explorations.get(explorationId) ?? [];
		const selected = branches.find(b => b.id === branchId);
		const abandoned = branches.filter(b => b.id !== branchId);

		if (selected) {
			await this._worktreeService.mergeWorktree(selected.worktree.id);
			selected.status = 'complete';
		}
		for (const branch of abandoned) {
			branch.status = 'abandoned';
			vibeLog.debug('Speculation', `Abandoned: ${branch.approach.slice(0, 30)}`);
		}
	}
}

registerSingleton(IVibeSpeculativeExplorationService, VibeSpeculativeExplorationService, InstantiationType.Delayed);
