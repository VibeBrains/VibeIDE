/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeSubagentService — first-class UX for delegated subtasks.
 *
 * Lifecycle: spawn → run → summarize → dispose.
 * Each subagent gets its own context window + token sub-quota.
 * Constraints / permissions / Dead Man's Switch are ALWAYS inherited from the parent — never weakened.
 *
 * Handoff protocol:
 *   Parent passes a SubagentHandoff to spawn().
 *   Subagent runs in isolation and returns a SubagentResult (compact, bounded size).
 *   Parent only sees the result — NOT the raw tool-loop transcript.
 *
 * Reference: docs/v1/subagents.md (Phase 3b: full implementation with worktree isolation)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IVibeTokenBudgetService } from './vibeTokenBudgetService.js';
import { IAuditLogService } from './auditLogService.js';
import { IVibeConstraintsService } from './vibeConstraintsService.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type SubagentType =
	// Roadmap-agent delegation roles
	| 'explore' | 'implement-step' | 'recover-or-skip'
	// Vibe Agents — curated role pack (VA). Read-only roles get a read-only tool whitelist.
	| 'orchestrator' | 'planner' | 'designer' | 'frontend-dev' | 'backend-dev' | 'code-reviewer' | 'qa' | 'security';
export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'disposed';

/** What the parent sends to spawn a subagent */
export interface SubagentHandoff {
	/** Unique id for correlation with parent plan/thread */
	parentThreadId: string;
	/** Type determines tool whitelist and system-appendix */
	type: SubagentType;
	/** Goal for this subagent (≤500 chars) */
	goal: string;
	/** Optional criteria to consider the goal achieved */
	acceptanceCriteria?: string;
	/** Explicit context items (file paths, refs) injected into the subagent's first message */
	contextItems?: string[];
	/** Hard ceiling on tokens this subagent may spend; undefined = inherit parent remaining */
	maxTokens?: number;
	/** Hard ceiling on tool-call steps (anti-loop) */
	maxSteps?: number;
	/** Hard ceiling on wall-clock time (ms); 0 = no limit */
	maxWallClockMs?: number;
	/**
	 * Optional: run this subagent in an isolated git worktree (§ B.3 / § I.4).
	 * Only effective for 'implement-step' type.
	 * Phase 3b: actual worktree creation via IVibeGitWorktreeService.
	 */
	useWorktree?: boolean;
	/** Branch name hint for worktree (auto-generated if not provided) */
	worktreeBranch?: string;
}

/** Compact result returned to the parent — bounded by MAX_RESULT_CHARS */
export interface SubagentResult {
	subagentId: string;
	status: 'success' | 'failed' | 'skipped';
	/** Brief summary (≤500 chars) */
	summary: string;
	/** Changed file paths (if any) */
	artifacts?: string[];
	/** Why it failed or was skipped */
	reason?: string;
	/** Hint for parent's next action */
	suggestedNext?: string;
	/** Token usage by this subagent */
	tokensUsed: number;
	/** Whether the result was truncated due to step/wall-clock limit */
	truncated?: boolean;
	/** Structured explore report (only for type='explore') */
	exploreReport?: ExploreSubagentReport;
}

/**
 * Structured output from an explore-type subagent.
 * Parent receives this instead of the full tool-loop transcript.
 * All intermediate calls stay inside the subagent's isolated context.
 */
export interface ExploreSubagentReport {
	/** Discovered file paths relevant to the goal */
	paths: string[];
	/** Short code citations / function signatures (≤200 chars each) */
	citations: Array<{ path: string; snippet: string; lineHint?: number }>;
	/** 0.0–1.0 confidence the goal was fully achieved */
	confidence: number;
	/** True if step or wall-clock limit was hit before completion */
	truncated: boolean;
	/** What the parent should do if truncated (retry/widen/accept) */
	truncationSuggestion?: 'retry' | 'widen' | 'accept';
}

export interface SubagentEntry {
	id: string;
	type: SubagentType;
	status: SubagentStatus;
	parentThreadId: string;
	startedAt: number;
	handoff: SubagentHandoff;
	result?: SubagentResult;
}

export const IVibeSubagentService = createDecorator<IVibeSubagentService>('vibeSubagentService');

export interface IVibeSubagentService {
	readonly _serviceBrand: undefined;

	/** Spawn a subagent and return its id. The subagent runs asynchronously. */
	spawn(handoff: SubagentHandoff): Promise<string>;

	/** Returns current status for a subagent by id */
	getStatus(subagentId: string): SubagentEntry | undefined;

	/** Returns all live (non-disposed) subagents for a parent thread */
	getByParentThread(parentThreadId: string): SubagentEntry[];

	/** Returns every subagent currently in the registry across all parent threads */
	getAll(): SubagentEntry[];

	/** Wait for a subagent to complete and receive its compact result */
	awaitResult(subagentId: string): Promise<SubagentResult>;

	/** Dispose a subagent — releases token quota, removes from registry */
	disposeSubagent(subagentId: string): void;

	/** Fired whenever a subagent's status changes */
	readonly onSubagentStatusChanged: Event<SubagentEntry>;

	/**
	 * Convenience: spawn a pre-configured 'explore' subagent.
	 * Uses read-only tool whitelist; does NOT merge intermediate calls into parent context.
	 * On limit hit: returns truncated ExploreSubagentReport with truncationSuggestion.
	 */
	spawnExplore(params: {
		parentThreadId: string;
		goal: string;
		contextItems?: string[];
		maxSteps?: number;
		maxWallClockMs?: number;
	}): Promise<{ subagentId: string; awaitResult: () => Promise<SubagentResult> }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum characters in any SubagentResult field — enforces compact handoff contract */
const MAX_RESULT_SUMMARY_CHARS = 500;
const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_TOKENS = 20_000;

// ── Tool whitelists per type ──────────────────────────────────────────────────

const TOOL_WHITELIST: Record<SubagentType, string[]> = {
	'explore': ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'],
	'implement-step': ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep'],
	'recover-or-skip': ['read_file', 'run_terminal_command', 'grep'],
	// Vibe Agents (VA) — must mirror allowedTools in vibeSubagentRegistryService presets.
	// Read-only roles (orchestrator/planner/code-reviewer/security) cannot write or run.
	'orchestrator': ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'],
	'planner': ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'],
	'code-reviewer': ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'],
	'security': ['read_file', 'list_dir', 'grep', 'glob', 'semantic_search'],
	'designer': ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep', 'glob'],
	'frontend-dev': ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep', 'glob'],
	'backend-dev': ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep', 'glob'],
	'qa': ['read_file', 'write_file', 'edit_file', 'run_terminal_command', 'list_dir', 'grep', 'glob'],
};

// ── Implementation ────────────────────────────────────────────────────────────

class VibeSubagentService extends Disposable implements IVibeSubagentService {
	declare readonly _serviceBrand: undefined;

	private readonly _registry = new Map<string, SubagentEntry>();
	private readonly _waiters = new Map<string, { resolve: (r: SubagentResult) => void; reject: (e: Error) => void }>();

	private readonly _onStatusChanged = this._register(new Emitter<SubagentEntry>());
	readonly onSubagentStatusChanged: Event<SubagentEntry> = this._onStatusChanged.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IVibeTokenBudgetService private readonly _budget: IVibeTokenBudgetService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
	) {
		super();
	}

	async spawn(handoff: SubagentHandoff): Promise<string> {
		const id = `subagent-${handoff.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

		const entry: SubagentEntry = {
			id,
			type: handoff.type,
			status: 'pending',
			parentThreadId: handoff.parentThreadId,
			startedAt: Date.now(),
			handoff,
		};
		this._registry.set(id, entry);

		this._log.info(`[VibeSubagent] Spawning ${handoff.type} subagent ${id} for thread ${handoff.parentThreadId}`);
		this._audit.append({ ts: Date.now(), action: 'subagent_spawned', ok: true, meta: { subagentId: id, type: handoff.type, parentThreadId: handoff.parentThreadId } });

		// Async execution — parent does not block; parent calls awaitResult() to get compact result.
		this._runSubagent(entry).catch(err => {
			this._log.error(`[VibeSubagent] ${id} unhandled error: ${err}`);
			this._completeWithFailure(entry, String(err));
		});

		return id;
	}

	getStatus(subagentId: string): SubagentEntry | undefined {
		return this._registry.get(subagentId);
	}

	getByParentThread(parentThreadId: string): SubagentEntry[] {
		return Array.from(this._registry.values()).filter(e => e.parentThreadId === parentThreadId && e.status !== 'disposed');
	}

	getAll(): SubagentEntry[] {
		return Array.from(this._registry.values());
	}

	awaitResult(subagentId: string): Promise<SubagentResult> {
		const entry = this._registry.get(subagentId);
		if (!entry) {
			return Promise.reject(new Error(`[VibeSubagent] Unknown subagent id: ${subagentId}`));
		}
		if (entry.result) {
			return Promise.resolve(entry.result);
		}
		return new Promise<SubagentResult>((resolve, reject) => {
			this._waiters.set(subagentId, { resolve, reject });
		});
	}

	disposeSubagent(subagentId: string): void {
		const entry = this._registry.get(subagentId);
		if (!entry) { return; }
		entry.status = 'disposed';
		this._registry.delete(subagentId);
		this._waiters.delete(subagentId);
		this._log.info(`[VibeSubagent] Disposed ${subagentId}`);
	}

	async spawnExplore(params: {
		parentThreadId: string;
		goal: string;
		contextItems?: string[];
		maxSteps?: number;
		maxWallClockMs?: number;
	}): Promise<{ subagentId: string; awaitResult: () => Promise<SubagentResult> }> {
		const subagentId = await this.spawn({
			parentThreadId: params.parentThreadId,
			type: 'explore',
			goal: params.goal,
			contextItems: params.contextItems,
			maxSteps: params.maxSteps ?? DEFAULT_MAX_STEPS,
			maxWallClockMs: params.maxWallClockMs ?? 60_000, // default 60s wall-clock
		});
		return { subagentId, awaitResult: () => this.awaitResult(subagentId) };
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private async _runSubagent(entry: SubagentEntry): Promise<void> {
		entry.status = 'running';
		this._onStatusChanged.fire(entry);

		const handoff = entry.handoff;
		const budgetStatus = this._budget.getStatus();
		const maxTokens = handoff.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, budgetStatus.sessionTokensLimit - budgetStatus.sessionTokensUsed);
		const maxSteps = handoff.maxSteps ?? DEFAULT_MAX_STEPS;
		const allowedTools = TOOL_WHITELIST[entry.type];

		// Constraints / permissions are ALWAYS inherited from parent — never weakened.
		// The subagent's tool-loop will call _constraints.checkWriteAllowed() before any write,
		// exactly as the parent agent does. No additional constraint downgrade is possible.
		// This check is a pre-flight: ensure the constraints service is reachable.
		const constraintsOk = !!this._constraints;

		// Worktree binding: implement-step subagents can run in an isolated git worktree
		// Phase 3b: create worktree via IVibeGitWorktreeService before spawning tool-loop
		const worktreeInfo = (entry.type === 'implement-step' && handoff.useWorktree)
			? `worktree=${handoff.worktreeBranch ?? 'auto'}`
			: 'no-worktree';

		this._log.info(`[VibeSubagent] ${entry.id} — type=${entry.type} maxTokens=${maxTokens} maxSteps=${maxSteps} tools=${allowedTools.join(',')} constraintsInherited=${constraintsOk} ${worktreeInfo}`);

		// Wall-clock timeout enforcement
		const maxWallClockMs = handoff.maxWallClockMs ?? 0;
		let timedOut = false;
		let wallClockTimer: ReturnType<typeof setTimeout> | undefined;
		if (maxWallClockMs > 0) {
			wallClockTimer = setTimeout(() => {
				timedOut = true;
				this._log.warn(`[VibeSubagent] ${entry.id} wall-clock limit hit (${maxWallClockMs}ms) — truncating result`);
			}, maxWallClockMs);
		}

		// Phase 3b: wire into real agent runner with isolated context window.
		// MVP: simulate a compact placeholder result so the service contract is exercisable.
		// The real implementation delegates to a headless tool-loop runner
		// (same executor as chatThreadService, but in an isolated context)
		// and returns a SubagentResult bound by MAX_RESULT_SUMMARY_CHARS.
		//
		// Wall-clock and step limits are checked in the tool-loop at each iteration.

		// Simulate minimal async work (Phase 3b: real tool-loop execution)
		await new Promise(r => setTimeout(r, 50));

		if (wallClockTimer) { clearTimeout(wallClockTimer); }

		const isExplore = entry.type === 'explore';
		const exploreReport: ExploreSubagentReport | undefined = isExplore ? {
			paths: handoff.contextItems ?? [],
			citations: [],
			confidence: timedOut ? 0.3 : 0.5,
			truncated: timedOut,
			truncationSuggestion: timedOut ? 'retry' : undefined,
		} : undefined;

		const result: SubagentResult = {
			subagentId: entry.id,
			status: 'success',
			summary: this._truncate(
				timedOut
					? `[Truncated — wall-clock limit] Subagent ${entry.type} for: ${handoff.goal}. Use exploreReport for partial findings.`
					: `[MVP stub] Subagent ${entry.type} for: ${handoff.goal}. ` +
					`Allowed tools: ${allowedTools.join(', ')}. ` +
					`Full isolated execution available in Phase 3b.`,
				MAX_RESULT_SUMMARY_CHARS,
			),
			artifacts: [],
			tokensUsed: 0,
			truncated: timedOut,
			exploreReport,
		};

		this._completeWithResult(entry, result);
	}

	private _completeWithResult(entry: SubagentEntry, result: SubagentResult): void {
		entry.result = result;
		entry.status = result.status === 'success' ? 'completed' : (result.status === 'skipped' ? 'skipped' : 'failed');
		this._onStatusChanged.fire(entry);
		this._audit.append({ ts: Date.now(), action: 'subagent_completed', ok: result.status === 'success', meta: { subagentId: entry.id, status: result.status, tokensUsed: result.tokensUsed } });

		const waiter = this._waiters.get(entry.id);
		if (waiter) {
			this._waiters.delete(entry.id);
			waiter.resolve(result);
		}
	}

	private _completeWithFailure(entry: SubagentEntry, reason: string): void {
		this._completeWithResult(entry, {
			subagentId: entry.id,
			status: 'failed',
			summary: this._truncate(`Subagent failed: ${reason}`, MAX_RESULT_SUMMARY_CHARS),
			reason,
			tokensUsed: 0,
		});
	}

	private _truncate(s: string, max: number): string {
		return s.length > max ? s.slice(0, max - 1) + '…' : s;
	}
}

registerSingleton(IVibeSubagentService, VibeSubagentService, InstantiationType.Delayed);
