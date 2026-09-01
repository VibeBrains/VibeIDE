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
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DEFAULT_SUBAGENT_TOKEN_QUOTA } from './subagentIsolationPolicy.js';
import type { SubagentStopReason } from './subagentLoopPolicy.js';
import type { ModelSelection, ProviderId } from './vibeideSettingsTypes.js';
import type { ChatImageAttachment } from './chatThreadServiceTypes.js';
import { IAuditLogService } from './auditLogService.js';
import { IVibeConstraintsService } from './vibeConstraintsService.js';
import { IVibeSubagentRunner } from './vibeSubagentRunner.js';
import { IVibeAgentRunLedgerService } from './vibeAgentRunLedgerService.js';
import { AgentRunStatus } from './agentRunLedger.js';
import { describeRoleBudgetRefusal, evaluateRoleBudget } from './agentRoleBudget.js';
import { IVibeideSettingsService } from './vibeideSettingsService.js';
import { IVibeSubagentRegistryService } from './vibeSubagentRegistryService.js';
import { breakerName, IVibeCircuitBreakerService, PROTECTIVE_BREAKERS } from './agentCircuitBreakers.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type SubagentType =
	// Roadmap-agent delegation roles
	| 'explore' | 'implement-step' | 'recover-or-skip'
	// Vibe Agents — curated role pack (VA). Read-only roles get a read-only tool whitelist.
	| 'orchestrator' | 'planner' | 'designer' | 'frontend-dev' | 'backend-dev' | 'code-reviewer' | 'qa' | 'security';
/**
 * Every role id, as data. The union above is the contract; this is the same list a runtime caller
 * can check a string against — a pipeline file names roles as plain text, and casting an unknown
 * string into the union would hand the tool whitelist an id nobody defined.
 */
export const SUBAGENT_TYPES: readonly SubagentType[] = [
	'explore', 'implement-step', 'recover-or-skip',
	'orchestrator', 'planner', 'designer', 'frontend-dev', 'backend-dev', 'code-reviewer', 'qa', 'security',
];

export function isSubagentType(value: string): value is SubagentType {
	return (SUBAGENT_TYPES as readonly string[]).includes(value);
}

export type SubagentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'skipped' | 'disposed';

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
	/**
	 * Image attachments handed to the subagent's first message (VA — vision routing, звено 2).
	 * Reuses the chat's `ChatImageAttachment` so the existing LLM-message converter base64-encodes
	 * them exactly as for the main thread. Only meaningful for roles whose resolved model supports
	 * vision — routing/gating of which role receives the image is a separate step.
	 */
	images?: readonly ChatImageAttachment[];
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
	/**
	 * Caller-supplied key that makes a spawn repeatable-safe: while a run started with this key is
	 * still alive, spawning it again returns the SAME id instead of starting a second role. Without
	 * it a retried route step, a double click or a re-entrant orchestrator silently doubles the
	 * spend. Omit it when a fresh run is genuinely wanted every time.
	 */
	idempotencyKey?: string;
	/**
	 * Model to run this role on, overriding the per-role mapping. Set by «повторить на другой
	 * модели»; absent = the usual resolution (per-role → chat).
	 */
	modelSelection?: ModelSelection | null;
	/** Run this is a replay of — recorded so the two can be compared afterwards. */
	replayOfRunId?: string;
}

/** Statuses that still hold the key — a finished run must not block a new attempt. */
const LIVE_SUBAGENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'running']);

/**
 * Id of the live run started with `key`, or `undefined` when none is. Pure — the registry is
 * passed in, so the rule is unit-testable without a workbench.
 */
export function findLiveRunByIdempotencyKey(entries: readonly SubagentEntry[], key: string): string | undefined {
	if (!key) {
		return undefined;
	}
	return entries.find(entry => entry.handoff.idempotencyKey === key && LIVE_SUBAGENT_STATUSES.has(entry.status))?.id;
}

/** Compact result returned to the parent — bounded by MAX_RESULT_CHARS */
export interface SubagentResult {
	subagentId: string;
	status: 'success' | 'failed' | 'stopped' | 'skipped';
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
	/** Machine-readable stop cause when a limit ended the run — drives the resume policy. */
	stopCode?: SubagentStopReason;
	/** Provider-reported prompt/completion token sums (raw) — for cost display. */
	promptTokensUsed?: number;
	completionTokensUsed?: number;
	/** Prompt-cache reads inside `promptTokensUsed` — the saving, shown rather than silently applied. */
	cachedTokensUsed?: number;
	/** Model that actually ran the role. */
	providerName?: ProviderId;
	modelName?: string;
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
	/** Live estimated tokens spent so far (updated per hop while `running`) — drives the chat spinner readout. */
	liveTokensUsed?: number;
	/** Resolved token quota for this run (`vibeide.subagent.maxTokens` or per-handoff) — the denominator in the readout. */
	tokenQuota?: number;
	/** Live completed steps (updated per hop while `running`) — the usual binding limit for weak models. */
	liveStepsDone?: number;
	/** Resolved step limit for this run — the denominator in the readout. */
	maxSteps?: number;
	/** Current absolute wall-clock deadline (unix ms; 0 = none) — drives the countdown in the readout. */
	deadlineAtMs?: number;
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

// ── Tool whitelists per type ──────────────────────────────────────────────────

// Tool names MUST be real builtin tool ids (`builtinToolDefs` keys) — the Phase 3b runner
// enforces this whitelist at every call, so a phantom name here silently bricks the role.
// (Pre-3b these tables carried nonexistent names — list_dir/write_file/semantic_search/
// run_terminal_command — which the MVP stub never exercised.)
const READONLY_TOOLS: string[] = ['read_file', 'ls_dir', 'grep', 'glob', 'search_for_files', 'search_pathnames_only', 'docs_search'];
const FULL_TOOLS: string[] = [...READONLY_TOOLS, 'edit_file', 'rewrite_file', 'create_file_or_folder', 'run_command'];

const TOOL_WHITELIST: Record<SubagentType, string[]> = {
	'explore': READONLY_TOOLS,
	'implement-step': FULL_TOOLS,
	'recover-or-skip': ['read_file', 'run_command', 'grep'],
	// Vibe Agents (VA) — must mirror allowedTools in vibeSubagentRegistryService presets.
	// Read-only roles (orchestrator/planner/code-reviewer/security) cannot write or run.
	'orchestrator': READONLY_TOOLS,
	'planner': READONLY_TOOLS,
	'code-reviewer': READONLY_TOOLS,
	'security': READONLY_TOOLS,
	'designer': FULL_TOOLS,
	'frontend-dev': FULL_TOOLS,
	'backend-dev': FULL_TOOLS,
	'qa': FULL_TOOLS,
};

// ── Implementation ────────────────────────────────────────────────────────────

class VibeSubagentService extends Disposable implements IVibeSubagentService {
	declare readonly _serviceBrand: undefined;

	private readonly _registry = new Map<string, SubagentEntry>();
	private readonly _waiters = new Map<string, { resolve: (r: SubagentResult) => void; reject: (e: Error) => void }>();
	/** Cancellation per live subagent (audit A) — disposeSubagent cancels the runner's loop. */
	private readonly _ctsById = new Map<string, CancellationTokenSource>();

	private readonly _onStatusChanged = this._register(new Emitter<SubagentEntry>());
	readonly onSubagentStatusChanged: Event<SubagentEntry> = this._onStatusChanged.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
		@IVibeSubagentRunner private readonly _runner: IVibeSubagentRunner,
		@IVibeAgentRunLedgerService private readonly _ledger: IVibeAgentRunLedgerService,
		@IVibeideSettingsService private readonly _settings: IVibeideSettingsService,
		@IVibeSubagentRegistryService private readonly _roleRegistry: IVibeSubagentRegistryService,
		@IVibeCircuitBreakerService private readonly _breakers: IVibeCircuitBreakerService,
	) {
		super();
	}

	async spawn(handoff: SubagentHandoff): Promise<string> {
		// Idempotency first: the same key must not buy a second run of the same work.
		if (handoff.idempotencyKey) {
			const existing = findLiveRunByIdempotencyKey(this.getAll(), handoff.idempotencyKey);
			if (existing) {
				this._log.info(`[VibeSubagent] Reusing live run ${existing} for idempotency key ${handoff.idempotencyKey}`);
				return existing;
			}
		}

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
		this._ctsById.set(id, new CancellationTokenSource());

		// The registry dies with the window and `disposeSubagent` empties it; the ledger is what
		// answers "who did what" afterwards, so the run is recorded before it starts working.
		this._ledger.recordStarted({
			runId: id,
			epoch: this._ledger.epoch,
			fence: this._ledger.allocateFence(),
			role: entry.type,
			goal: handoff.goal,
			parentThreadId: handoff.parentThreadId,
			status: 'pending',
			startedAt: entry.startedAt,
			...(handoff.replayOfRunId ? { replayOfRunId: handoff.replayOfRunId } : {}),
		});

		this._log.info(`[VibeSubagent] Spawning ${handoff.type} subagent ${id} for thread ${handoff.parentThreadId}`);
		this._audit.append({ actor: 'subagent', actorId: id, ts: Date.now(), action: 'subagent_spawned', ok: true, meta: { subagentId: id, type: handoff.type, parentThreadId: handoff.parentThreadId } });

		// Cumulative role budget. `maxTokens` caps one run; this caps the role across many, so a
		// role that already spent its allowance does not start at all. The refusal is recorded as
		// a skipped run rather than thrown away — a run that did not happen for a reason is a fact
		// worth seeing in the dispatch panel.
		// A latched protective breaker stops roles too. The chat loop checks this before its own
		// run, but a role is spawned through here — and it is the role that What's New promises to
		// stop. Recorded as `skipped`, exactly like a spent budget: a run that did not happen for a
		// reason belongs in the dispatch panel, not in silence.
		const blocking = PROTECTIVE_BREAKERS.filter(breaker => this._breakers.isBlocking(breaker));
		if (blocking.length > 0) {
			const reasons = blocking.map(breaker => this._breakers.snapshot(breaker).reason || breakerName(breaker)).join('; ');
			const message = `Роль не запущена: сработал защитный предохранитель — ${reasons}. Снимается командой «VibeIDE: Предохранители агента».`;
			this._completeWithResult(entry, {
				subagentId: id,
				status: 'skipped',
				summary: this._truncate(message, MAX_RESULT_SUMMARY_CHARS),
				reason: message,
				tokensUsed: 0,
			});
			return id;
		}

		const refusal = await this._roleBudgetRefusal(handoff.type);
		if (refusal) {
			this._completeWithResult(entry, {
				subagentId: id,
				status: 'skipped',
				summary: this._truncate(refusal, MAX_RESULT_SUMMARY_CHARS),
				reason: refusal,
				tokensUsed: 0,
			});
			return id;
		}

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
		// Disposing a run that never reached an outcome IS the outcome — record it before the
		// registry entry goes, otherwise the run vanishes without a trace (the old behaviour).
		if (!entry.result) {
			this._ledger.recordUpdate({
				runId: subagentId,
				status: 'stopped',
				endedAt: Date.now(),
				stopCode: 'cancelled',
				tokensUsed: entry.liveTokensUsed,
				stepsDone: entry.liveStepsDone,
			});
		}
		entry.status = 'disposed';
		this._registry.delete(subagentId);
		this._waiters.delete(subagentId);
		// Audit A: a live runner loop must die with its registry entry — cancel stops it at
		// the hop boundary and aborts the in-flight LLM request (no more token burn).
		const cts = this._ctsById.get(subagentId);
		if (cts) {
			cts.cancel();
			cts.dispose();
			this._ctsById.delete(subagentId);
		}
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

	/**
	 * Refusal text when the role has no allowance left, or `undefined` when it may run.
	 * Reads the ledger, so the ceiling is enforced against what actually happened — including
	 * runs from earlier windows of the IDE.
	 */
	private async _roleBudgetRefusal(role: SubagentType): Promise<string | undefined> {
		const budgets = this._settings.state.tokenBudgetOfRole ?? {};
		if (!budgets[role]) {
			return undefined;
		}
		const windowDays = this._configuration.getValue<number>('vibeide.subagent.budgetWindowDays');
		const days = typeof windowDays === 'number' && Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 1;
		const state = evaluateRoleBudget(await this._ledger.getRuns(), role, budgets, Date.now(), days);
		if (!state.exhausted) {
			return undefined;
		}
		return describeRoleBudgetRefusal(state, this._roleRegistry.getPreset(role).displayName, days);
	}

	private async _runSubagent(entry: SubagentEntry): Promise<void> {
		entry.status = 'running';
		this._onStatusChanged.fire(entry);

		const handoff = entry.handoff;
		// The subagent's token quota is its OWN budget (config `vibeide.subagent.maxTokens`), NOT the
		// session remainder. Coupling to the remainder starved a role (and, on autopilot, every role)
		// the moment the parent had spent most of the session — the ~20k first-hop abort. The global
		// session guard (sendLLMMessageService) stays the backstop against overspend.
		const configuredQuota = this._configuration.getValue<number>('vibeide.subagent.maxTokens');
		const maxTokens = handoff.maxTokens ?? (typeof configuredQuota === 'number' && configuredQuota > 0 ? configuredQuota : DEFAULT_SUBAGENT_TOKEN_QUOTA);
		const maxSteps = handoff.maxSteps ?? DEFAULT_MAX_STEPS;
		const allowedTools = TOOL_WHITELIST[entry.type];

		// Live readout (chat spinner): expose the quotas now and stream per-hop spend below.
		entry.tokenQuota = Math.max(0, maxTokens);
		entry.liveTokensUsed = 0;
		entry.maxSteps = maxSteps;
		entry.liveStepsDone = 0;

		// Ceilings are part of the record: without them a stopped run reads as a failure instead of
		// "hit its budget". Live progress stays in memory — the ledger keeps milestones, not telemetry.
		this._ledger.recordUpdate({ runId: entry.id, status: 'running', tokenQuota: entry.tokenQuota, maxSteps });

		// Constraints / permissions are ALWAYS inherited from parent — never weakened.
		// The runner executes tools through the same IToolsService as the parent agent, so
		// every constraints check (checkWriteAllowed etc.) applies identically; on top of
		// that the runner enforces the role's tool whitelist at each call.
		const constraintsOk = !!this._constraints;

		// Worktree binding: implement-step subagents can run in an isolated git worktree.
		// Still a later phase: create worktree via IVibeGitWorktreeService before the loop.
		const worktreeInfo = (entry.type === 'implement-step' && handoff.useWorktree)
			? `worktree=${handoff.worktreeBranch ?? 'auto'} (not yet created — later phase)`
			: 'no-worktree';

		this._log.info(`[VibeSubagent] ${entry.id} — type=${entry.type} maxTokens=${maxTokens} maxSteps=${maxSteps} tools=${allowedTools.join(',')} constraintsInherited=${constraintsOk} ${worktreeInfo}`);

		// Phase 3b: the real headless tool-loop. Step / wall-clock / token limits are
		// enforced inside the runner at every iteration; the outcome is already compact.
		const outcome = await this._runner.run({
			subagentId: entry.id,
			type: entry.type,
			goal: handoff.goal,
			acceptanceCriteria: handoff.acceptanceCriteria,
			contextItems: handoff.contextItems,
			images: handoff.images,
			allowedTools,
			maxSteps,
			maxTokensEst: Math.max(0, maxTokens),
			maxWallClockMs: handoff.maxWallClockMs ?? 0,
			modelSelection: handoff.modelSelection,
			cancellationToken: this._ctsById.get(entry.id)?.token,
			onProgress: (tokensUsedEst, stepsDone, deadlineAtMs) => {
				// Per-hop live spend → chat spinner. Only while still running; terminal state
				// carries the final tokens in `result`.
				if (entry.status === 'running') {
					entry.liveTokensUsed = tokensUsedEst;
					entry.liveStepsDone = stepsDone;
					entry.deadlineAtMs = deadlineAtMs;
					this._onStatusChanged.fire(entry);
				}
			},
		});

		const result: SubagentResult = {
			subagentId: entry.id,
			status: outcome.status,
			summary: this._truncate(outcome.summary, MAX_RESULT_SUMMARY_CHARS),
			artifacts: outcome.artifacts,
			tokensUsed: outcome.tokensUsedEst,
			truncated: outcome.truncated || undefined,
			...(outcome.status !== 'success' ? { reason: outcome.stopReason } : {}),
			...(outcome.stopCode ? { stopCode: outcome.stopCode } : {}),
			...(outcome.promptTokensUsed ? { promptTokensUsed: outcome.promptTokensUsed } : {}),
			...(outcome.completionTokensUsed ? { completionTokensUsed: outcome.completionTokensUsed } : {}),
			...(outcome.cachedTokensUsed ? { cachedTokensUsed: outcome.cachedTokensUsed } : {}),
			...(outcome.providerName ? { providerName: outcome.providerName, modelName: outcome.modelName } : {}),
			...(outcome.exploreReport ? { exploreReport: outcome.exploreReport } : {}),
		};

		this._completeWithResult(entry, result);
	}

	private _completeWithResult(entry: SubagentEntry, result: SubagentResult): void {
		// The loop is over — release the cancellation source (dispose-after-complete is a no-op path).
		const cts = this._ctsById.get(entry.id);
		if (cts) {
			cts.dispose();
			this._ctsById.delete(entry.id);
		}
		entry.result = result;
		entry.status = result.status === 'success' ? 'completed' : (result.status === 'skipped' ? 'skipped' : (result.status === 'stopped' ? 'stopped' : 'failed'));
		this._onStatusChanged.fire(entry);
		this._ledger.recordUpdate({
			runId: entry.id,
			status: entry.status as AgentRunStatus,
			endedAt: Date.now(),
			tokensUsed: result.tokensUsed,
			cachedTokens: result.cachedTokensUsed,
			stepsDone: entry.liveStepsDone,
			artifacts: result.artifacts,
			stopCode: result.stopCode,
			provider: result.providerName,
			model: result.modelName,
			summary: result.summary,
			failureReason: result.status === 'success' ? undefined : result.reason,
		});
		this._audit.append({ actor: 'subagent', actorId: entry.id, ts: Date.now(), action: 'subagent_completed', ok: result.status === 'success', meta: { subagentId: entry.id, status: result.status, tokensUsed: result.tokensUsed } });

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
