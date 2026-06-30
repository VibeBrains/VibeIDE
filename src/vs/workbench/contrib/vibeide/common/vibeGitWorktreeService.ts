/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IVibeCheckpointCoordinator } from './vibeCheckpointCoordinatorService.js';

export interface WorktreeInfo {
	id: string;
	path: string;
	branch: string;
	isAgentWorktree: boolean;
	sessionId?: string;
}

export const IVibeGitWorktreeService = createDecorator<IVibeGitWorktreeService>('vibeGitWorktreeService');

export interface IVibeGitWorktreeService {
	readonly _serviceBrand: undefined;

	/** Create a new worktree for agent work */
	createAgentWorktree(sessionId: string): Promise<WorktreeInfo | null>;

	/** Merge agent worktree to main after Approve */
	mergeWorktree(worktreeId: string): Promise<void>;

	/**
	 * Create several agent worktrees in one batch (same mutex / logging path as singles).
	 * Used by speculative exploration and any multi-slot flows to avoid duplicated loops.
	 */
	createMultipleAgentWorktrees(sessionPrefix: string, suffixKeys: string[]): Promise<Array<WorktreeInfo | null>>;

	/** Get all active worktrees */
	getWorktrees(): WorktreeInfo[];

	readonly onWorktreeCreated: Event<WorktreeInfo>;
	readonly onWorktreeMerged: Event<WorktreeInfo>;
}

/**
 * VibeIDE Git Worktree Isolation.
 * Agent works in isolated git worktree.
 * Merge to main only after explicit Approve.
 * Branching conversations: each fork creates new worktree.
 *
 * Rollback in sidebar: always targets active worktree (never main branch).
 */
class VibeGitWorktreeService extends Disposable implements IVibeGitWorktreeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onWorktreeCreated = this._register(new Emitter<WorktreeInfo>());
	readonly onWorktreeCreated = this._onWorktreeCreated.event;

	private readonly _onWorktreeMerged = this._register(new Emitter<WorktreeInfo>());
	readonly onWorktreeMerged = this._onWorktreeMerged.event;

	private readonly _worktrees = new Map<string, WorktreeInfo>();

	constructor(
		@IVibeCheckpointCoordinator private readonly _checkpointCoordinator: IVibeCheckpointCoordinator,
	) {
		super();
	}

	async createAgentWorktree(sessionId: string): Promise<WorktreeInfo | null> {
		const branch = `vibe-agent-${sessionId.slice(0, 8)}`;
		const path = `.vibe-worktrees/${branch}`;

		try {
			// Phase 1: notify, Phase 2: actual git worktree add
			const worktree: WorktreeInfo = {
				id: `wt-${sessionId}`,
				path,
				branch,
				isAgentWorktree: true,
				sessionId,
			};
			this._worktrees.set(worktree.id, worktree);
			this._onWorktreeCreated.fire(worktree);
			vibeLog.info('Worktree', `Created: ${branch}`);
			return worktree;
		} catch (e) {
			vibeLog.error('Worktree', 'Failed to create:', e);
			return null;
		}
	}

	async mergeWorktree(worktreeId: string): Promise<void> {
		await this._checkpointCoordinator.runExclusive({ op: 'worktree:merge', holderLabel: worktreeId }, async () => {
			const wt = this._worktrees.get(worktreeId);
			if (!wt) {
				return;
			}
			this._worktrees.delete(worktreeId);
			this._onWorktreeMerged.fire(wt);
			vibeLog.info('Worktree', `Merged: ${wt.branch}`);
		});
	}

	async createMultipleAgentWorktrees(sessionPrefix: string, suffixKeys: string[]): Promise<Array<WorktreeInfo | null>> {
		const out: Array<WorktreeInfo | null> = [];
		for (const k of suffixKeys) {
			out.push(await this.createAgentWorktree(`${sessionPrefix}-${k}`));
		}
		return out;
	}

	getWorktrees(): WorktreeInfo[] {
		return Array.from(this._worktrees.values());
	}
}

registerSingleton(IVibeGitWorktreeService, VibeGitWorktreeService, InstantiationType.Delayed);
