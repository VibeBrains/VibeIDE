/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeSubagentOrchestratorService — completion protocol and retry/skip policy.
 *
 * Manages the "§ I.3 Protocol for completion and progress marks" requirements:
 *
 * SUCCESS path:
 *   Parent atomically marks the plan step as done (via IVibePersistedPlanService / .steps.json
 *   with single-writer guarantees), then enqueues the next item or next subagent spawn.
 *
 * FAILED path:
 *   Retry policy: up to N retries through a new `recover-or-skip` subagent.
 *   If retries exhausted: skip with a record in the plan/journal and continue
 *   to the next item WITHOUT stopping the roadmap.
 *
 * SKIPPED path:
 *   Record in audit log + plan journal; continue to next item.
 *
 * All state transitions are atomic (temp file + rename, as in § A.2 plan contract).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IAuditLogService } from './auditLogService.js';
import { SubagentResult, SubagentType, IVibeSubagentService } from './vibeSubagentService.js';
import type { ChatImageAttachment } from './chatThreadServiceTypes.js';
import { IVibeSubagentRegistryService } from './vibeSubagentRegistryService.js';
import { IVibeSubagentHandoffStore, SubagentHandoffTicket, buildResumeGoal, escalateResumeQuota } from './vibeSubagentHandoffStore.js';
import { DEFAULT_SUBAGENT_TOKEN_QUOTA } from './subagentIsolationPolicy.js';
import { buildRoute, VibeAgentRoute } from './vibeAgentRoutes.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IVibeAgentRunLedgerService } from './vibeAgentRunLedgerService.js';
import { AgentSessionIdentity, compareAgentSessionIdentity, computeAgentSessionFingerprint, sessionMismatchToRussian } from './agentRunFingerprint.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.subagent.maxRetries': {
			type: 'number',
			default: 2,
			minimum: 0,
			maximum: 5,
			description: localize('vibeide.subagent.maxRetries', 'Максимальное число повторов для упавшего шага субагента, после которого шаг автоматически пропускается.'),
		},
		'vibeide.subagent.autoSkipOnRetryExhausted': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.subagent.autoSkipOnRetryExhausted', 'Автоматически пропускать шаг субагента и переходить к следующему пункту, когда все повторы исчерпаны. Если выключено — roadmap-агент ставится на паузу.'),
		},
		'vibeide.subagent.maxResumes': {
			type: 'number',
			default: 2,
			minimum: 0,
			maximum: 10,
			description: localize('vibeide.subagent.maxResumes', 'Сколько раз VibeIDE САМ продолжит остановленную по лимиту (токены/шаги/время) роль-субагента с сохранённого места, прежде чем передать решение пользователю (ручной список «Продолжить роль»). 0 = не продолжать автоматически. Субагентный аналог «подпин.» основного агента. Дефолт 2. ПРИМЕЧАНИЕ: при включённом автопилоте ресурсные лимиты роли авто-продлеваются и роль не паркуется — этот лимит действует в ручном режиме.'),
		},
		'vibeide.subagent.budgetWindowDays': {
			type: 'number',
			default: 1,
			minimum: 1,
			description: localize('vibeide.subagent.budgetWindowDays', 'За сколько последних суток считать бюджет роли. `vibeide.subagent.maxTokens` ограничивает ОДИН прогон; бюджет роли (настраивается в «Роли агентов») ограничивает суммарный расход роли за это окно — двадцать прогонов, каждый в своём лимите, всё равно стоят двадцати лимитов. Дефолт 1 — сутки.'),
		},
		'vibeide.subagent.maxSteps': {
			type: 'number',
			default: 60,
			minimum: 5,
			maximum: 500,
			description: localize('vibeide.subagent.maxSteps', 'Лимит шагов (обращений к модели/инструментам) на ОДИН прогон роли-субагента, прежде чем она остановится по «исчерпан лимит шагов». Переопределяет дефолт роли. Для слабых моделей поднимайте — они жгут шаги на чтении файлов. При включённом автопилоте лимит авто-продлевается (роль не встаёт). Дефолт 60.'),
		},
		'vibeide.subagent.maxWallClockSec': {
			type: 'number',
			default: 300,
			minimum: 10,
			maximum: 3600,
			description: localize('vibeide.subagent.maxWallClockSec', 'Лимит времени (секунды) на ОДИН прогон роли-субагента, прежде чем она остановится по «исчерпан лимит времени». Переопределяет дефолт роли (30–180 с). В чат-индикаторе показывается обратным отсчётом. При включённом автопилоте авто-продлевается (роль не встаёт). Дефолт 300 (5 минут).'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type StepCompletionStatus = 'done' | 'skipped' | 'paused_for_human';

export interface StepCompletionRecord {
	stepId: string;
	planId?: string;
	parentThreadId: string;
	status: StepCompletionStatus;
	subagentId: string;
	subagentStatus: SubagentResult['status'];
	retriesUsed: number;
	/** Reason for skip or pause */
	reason?: string;
	/** Artifacts from successful step */
	artifacts?: string[];
	completedAt: number;
}

export const IVibeSubagentOrchestratorService = createDecorator<IVibeSubagentOrchestratorService>('vibeSubagentOrchestratorService');

/** Per-run limit overrides (from the «маршрут ролей» modal) — each field falls back to config when absent. */
export interface SubagentLimitOverrides {
	readonly maxSteps?: number;
	readonly maxTokens?: number;
	readonly maxWallClockMs?: number;
	readonly maxResumes?: number;
}

export interface IVibeSubagentOrchestratorService {
	readonly _serviceBrand: undefined;

	/**
	 * Handle completion of a subagent run:
	 *  - success → atomically mark plan step done → enqueue next
	 *  - failed → retry up to maxRetries → then skip or pause
	 *  - skipped → record and continue
	 *
	 * Returns the StepCompletionRecord describing the final outcome.
	 */
	handleCompletion(params: {
		stepId: string;
		planId?: string;
		parentThreadId: string;
		result: SubagentResult;
		retriesUsed?: number;
	}): Promise<StepCompletionRecord>;

	/**
	 * Retry a failed step by spawning a `recover-or-skip` subagent.
	 * Returns true if retry was initiated, false if max retries exhausted.
	 */
	retryStep(params: {
		stepId: string;
		planId?: string;
		parentThreadId: string;
		originalResult: SubagentResult;
		retryCount: number;
	}): Promise<{ retried: boolean; nextResult?: SubagentResult }>;

	/** Get all completion records for a plan */
	getCompletionHistory(planId: string): StepCompletionRecord[];

	/** Classify a task into an ordered role workflow (Vibe Agents — VA.3/VA.4). Pure, no spawn.
	 *  `hasImages` promotes a leading vision stage (звено 1) so the preview matches execution. */
	planRoute(taskText: string, opts?: { hasImages?: boolean }): VibeAgentRoute;

	/**
	 * Run the role workflow for a task: spawn each role in sequence, handing the previous
	 * role's summary forward as context. Stops the chain on the first failure. Attached `images`
	 * are handed ONLY to the route's vision sink role (звено 1/2) — downstream roles get its text.
	 */
	executeRoute(params: { parentThreadId: string; taskText: string; overrides?: SubagentLimitOverrides; images?: readonly ChatImageAttachment[] }): Promise<SubagentResult[]>;

	/** Manually resume a subagent stopped by a limit, from its durable handoff ticket. */
	resume(ticketId: string): Promise<SubagentResult | undefined>;

	/** Open handoff tickets awaiting a human decision — drives the «субпин» indicator/picker. */
	listOpenHandoffs(): readonly SubagentHandoffTicket[];
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeSubagentOrchestratorService extends Disposable implements IVibeSubagentOrchestratorService {
	declare readonly _serviceBrand: undefined;

	private readonly _history = new Map<string, StepCompletionRecord[]>(); // planId → records

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IVibeSubagentService private readonly _subagentSvc: IVibeSubagentService,
		@IVibeSubagentRegistryService private readonly _registry: IVibeSubagentRegistryService,
		@IVibeSubagentHandoffStore private readonly _handoffStore: IVibeSubagentHandoffStore,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibeAgentRunLedgerService private readonly _ledger: IVibeAgentRunLedgerService,
	) {
		super();
	}

	planRoute(taskText: string, opts?: { hasImages?: boolean }): VibeAgentRoute {
		return buildRoute(taskText, opts);
	}

	async executeRoute(params: { parentThreadId: string; taskText: string; overrides?: SubagentLimitOverrides; images?: readonly ChatImageAttachment[] }): Promise<SubagentResult[]> {
		const { parentThreadId, taskText, overrides, images } = params;
		const hasImages = !!(images && images.length);
		const route = buildRoute(taskText, { hasImages });
		this._log.info(`[SubagentOrchestrator] route ${route.kind}: ${route.roles.join(' → ')}${route.securityAdded ? ' (+security)' : ''}`);
		this._audit.append({ actor: 'agent', ts: Date.now(), action: 'agent_route_started', ok: true, meta: { kind: route.kind, roles: route.roles, securityAdded: route.securityAdded } });

		const results: SubagentResult[] = [];
		let priorSummary = '';
		for (const stage of route.stages) {
			// Roles within a stage are independent → run them in parallel. The attached image goes
			// ONLY to the route's vision sink role (звено 1/2); everyone else works off its text handoff.
			const stageResults = await Promise.all(stage.map(role =>
				this._runRole(role, parentThreadId, taskText, priorSummary, overrides, role === route.imageSink ? images : undefined)));
			let failed = false;
			const summaries: string[] = [];
			for (let i = 0; i < stageResults.length; i++) {
				// A spawn/run exception yields `undefined` (no SubagentResult) — synthesize a failed
				// result so the route report always names the role and its failure instead of showing
				// an empty report.
				const r: SubagentResult = stageResults[i] ?? {
					subagentId: stage[i],
					status: 'failed',
					summary: '',
					reason: localize('subagent.spawnFailed', "Спавн или запуск роли не удался"),
					tokensUsed: 0,
				};
				// Record failed results too (so the user sees the reason), then stop the route below;
				// only successful summaries flow to the next stage as context.
				results.push(r);
				// 'stopped' (partial by limit) also halts forward progress — the next stage must not
				// build on incomplete upstream work — but its partial summary stays in `results` for the
				// report and for a future resume/handoff (durable-handoff workstream).
				if (r.status !== 'success') {
					failed = true;
				} else if (r.summary) {
					summaries.push(r.summary);
				}
			}
			if (failed) {
				this._log.warn(`[SubagentOrchestrator] stage [${stage.join(', ')}] had a failure — stopping route`);
				break;
			}
			priorSummary = summaries.join('\n\n') || priorSummary;
		}
		return results;
	}

	/** Spawns and awaits a single role; resolves to undefined on spawn/run error. */
	private async _spawnRole(role: SubagentType, parentThreadId: string, goal: string, maxTokens?: number, overrides?: SubagentLimitOverrides, images?: readonly ChatImageAttachment[]): Promise<SubagentResult | undefined> {
		const preset = this._registry.getPreset(role);
		try {
			// Limit precedence: per-run override (modal) → global config → per-role default. Under autopilot
			// the runner auto-extends steps/time anyway — the override sets the base.
			const cfgMaxSteps = this._config.getValue<number>('vibeide.subagent.maxSteps');
			const maxSteps = overrides?.maxSteps ?? (typeof cfgMaxSteps === 'number' && cfgMaxSteps > 0 ? cfgMaxSteps : preset.defaultMaxSteps);
			const cfgWallSec = this._config.getValue<number>('vibeide.subagent.maxWallClockSec');
			const maxWallClockMs = overrides?.maxWallClockMs ?? (typeof cfgWallSec === 'number' && cfgWallSec > 0 ? cfgWallSec * 1000 : preset.defaultMaxWallClockMs);
			const subagentId = await this._subagentSvc.spawn({
				parentThreadId,
				type: role,
				goal,
				maxSteps,
				maxWallClockMs,
				...(maxTokens ? { maxTokens } : {}),
				...(images && images.length ? { images } : {}),
			});
			return await this._subagentSvc.awaitResult(subagentId);
		} catch (err) {
			this._log.error(`[SubagentOrchestrator] role ${role} failed: ${err}`);
			return undefined;
		}
	}

	/** Limits that are safe to continue automatically. NOT here: 'denied-actions' (the user already
	 *  rejected these tool calls — auto-resume would re-ask against their decision) and 'cancelled'
	 *  (hard 'failed' in the runner, never reaches this policy). */
	private static readonly _AUTO_RESUMABLE: ReadonlySet<string> = new Set(['token-budget', 'max-steps', 'deadline']);

	/**
	 * Ground a run stood on, as far as it is knowable here: the provider and model are only
	 * reported once a run has actually executed, so identities are taken from finished results
	 * rather than guessed before the spawn.
	 */
	private _identityOf(role: SubagentType, parentThreadId: string, result: SubagentResult): AgentSessionIdentity {
		const folders = this._workspace.getWorkspace().folders;
		return {
			role,
			provider: result.providerName ?? '',
			model: result.modelName ?? '',
			parentThreadId,
			workspaceKey: folders.length > 0 ? folders[0].uri.toString() : '',
			allowedTools: this._registry.getPreset(role).allowedTools,
		};
	}

	private _resumeQuota(resumeIndex: number): number {
		const base = this._config.getValue<number>('vibeide.subagent.maxTokens');
		const factor = this._config.getValue<number>('vibeide.subagent.resumeBudgetFactor') ?? 1.5;
		return escalateResumeQuota(typeof base === 'number' && base > 0 ? base : DEFAULT_SUBAGENT_TOKEN_QUOTA, resumeIndex, factor);
	}

	private async _runRole(role: SubagentType, parentThreadId: string, taskText: string, priorSummary: string, overrides?: SubagentLimitOverrides, images?: readonly ChatImageAttachment[]): Promise<SubagentResult | undefined> {
		const preset = this._registry.getPreset(role);
		const maxResumes = overrides?.maxResumes ?? this._config.getValue<number>('vibeide.subagent.maxResumes') ?? 2;
		let partial = '';
		let ticket: SubagentHandoffTicket | undefined;
		let attempt = 0; // spawns completed (1 = initial, then one per auto-resume)

		while (true) {
			const goal = buildResumeGoal(taskText, preset.displayName, partial, priorSummary);
			// Each resume gets an escalated budget: the same quota that just ran out would stall again
			// sooner (the «already done» preamble grows). attempt=0 → the per-run override (or config default).
			const maxTokens = attempt === 0 ? overrides?.maxTokens : this._resumeQuota(attempt);
			// Images ride only the initial spawn; durable-handoff tickets don't persist image blobs, so
			// a resumed vision role works from its own prior text summary, not the raw image again.
			const result = await this._spawnRole(role, parentThreadId, goal, maxTokens, overrides, attempt === 0 ? images : undefined);
			attempt++;

			if (!result || result.status !== 'stopped') {
				if (ticket) {
					if (result?.status === 'success') {
						// Completed — nothing left to hand off.
						this._handoffStore.remove(ticket.id);
					} else {
						// Hard-fail / spawn exception AFTER partial work: keep the ticket open so the
						// partial stays reachable via «субпин» (a transient error must not eat it).
						this._handoffStore.update(ticket.id, { status: 'open', stopReason: result?.reason ?? localize('subagent.spawnFailed', "Спавн или запуск роли не удался") });
					}
				}
				return result;
			}

			// Stopped by a limit: persist the partial work so nothing is lost (survives restart).
			partial = result.summary || partial;
			const progress = { partialSummary: partial, artifacts: result.artifacts ?? [], stopReason: result.reason ?? 'stopped', tokensUsed: result.tokensUsed };
			const identity = this._identityOf(role, parentThreadId, result);
			const fingerprint = computeAgentSessionFingerprint(identity);
			if (ticket) {
				this._handoffStore.update(ticket.id, { ...progress, resumeCount: attempt, identity, fingerprint });
			} else {
				ticket = this._handoffStore.create({ parentThreadId, role, taskText, priorContext: priorSummary || undefined, ...progress, identity, fingerprint });
			}

			const autoOk = !!result.stopCode && VibeSubagentOrchestratorService._AUTO_RESUMABLE.has(result.stopCode);
			if (!autoOk || attempt > maxResumes) {
				// Auto-resumes exhausted (or the stop kind must not be auto-resumed) → human decides.
				this._handoffStore.update(ticket.id, { status: 'open' });
				this._log.warn(`[SubagentOrchestrator] role ${role} stopped (${result.stopCode ?? 'no-code'}) after ${attempt} spawn(s) — ticket ${ticket.id} left open for manual resume`);
				return result;
			}
			this._handoffStore.update(ticket.id, { status: 'resumed' });
			this._log.info(`[SubagentOrchestrator] role ${role} stopped — auto-resume ${attempt}/${maxResumes}, quota ×${(this._resumeQuota(attempt) / this._resumeQuota(0)).toFixed(1)} (ticket ${ticket.id})`);
		}
	}

	async resume(ticketId: string): Promise<SubagentResult | undefined> {
		const t = this._handoffStore.get(ticketId);
		// Only 'open' tickets are resumable — guards a double-resume race (manual while auto runs).
		if (!t || t.status !== 'open') { return undefined; }
		const preset = this._registry.getPreset(t.role);
		this._handoffStore.update(ticketId, { status: 'resumed' });
		const goal = buildResumeGoal(t.taskText, preset.displayName, t.partialSummary, t.priorContext);
		const result = await this._spawnRole(t.role, t.parentThreadId, goal, this._resumeQuota(t.resumeCount + 1));

		// A ticket outlives the window that wrote it. If the ground moved — another model, a
		// changed whitelist — the pickup still happens, but the run carries the reason so the
		// dispatch panel can say why this is a new session instead of a seamless continuation.
		if (result && t.identity) {
			const mismatch = compareAgentSessionIdentity(t.identity, this._identityOf(t.role, t.parentThreadId, result));
			if (mismatch) {
				this._ledger.recordUpdate({ runId: result.subagentId, resumeReason: mismatch });
				this._log.info(`[SubagentOrchestrator] resume ${ticketId} continued on moved ground: ${sessionMismatchToRussian(mismatch)}`);
			}
		}
		if (result?.status === 'success') {
			// Completed — the handoff is fulfilled, drop the ticket.
			this._handoffStore.remove(ticketId);
		} else if (result?.status === 'stopped') {
			// Stopped again → keep open with the accumulated partial for another pickup.
			this._handoffStore.update(ticketId, {
				status: 'open',
				partialSummary: result.summary || t.partialSummary,
				artifacts: result.artifacts ?? t.artifacts,
				stopReason: result.reason ?? t.stopReason,
				tokensUsed: result.tokensUsed,
				resumeCount: t.resumeCount + 1,
			});
		} else {
			this._handoffStore.update(ticketId, { status: 'open', resumeCount: t.resumeCount + 1 });
		}
		return result;
	}

	listOpenHandoffs(): readonly SubagentHandoffTicket[] {
		return this._handoffStore.listOpen();
	}

	async handleCompletion(params: {
		stepId: string;
		planId?: string;
		parentThreadId: string;
		result: SubagentResult;
		retriesUsed?: number;
	}): Promise<StepCompletionRecord> {
		const { stepId, planId, parentThreadId, result } = params;
		const retriesUsed = params.retriesUsed ?? 0;

		this._log.info(`[SubagentOrchestrator] Step ${stepId} — result: ${result.status} (retries: ${retriesUsed})`);

		let record: StepCompletionRecord;

		if (result.status === 'success') {
			// SUCCESS: atomically mark plan step done
			await this._markStepDone(stepId, planId, result);
			record = {
				stepId, planId, parentThreadId,
				status: 'done',
				subagentId: result.subagentId,
				subagentStatus: result.status,
				retriesUsed,
				artifacts: result.artifacts,
				completedAt: Date.now(),
			};
			this._audit.append({ actor: 'subagent', actorId: result.subagentId, ts: Date.now(), action: 'plan_step_completed', ok: true, meta: { stepId, planId, subagentId: result.subagentId, artifacts: result.artifacts } });

		} else if (result.status === 'failed' || result.status === 'stopped') {
			// 'stopped' (limit hit, partial work) goes through the same recover-or-skip retry machinery
			// as 'failed' — but the record keeps the honest subagentStatus (was silently mislabeled
			// 'skipped' before, losing the partial-work signal from plan-step history).
			const maxRetries = this._config.getValue<number>('vibeide.subagent.maxRetries') ?? 2;

			if (retriesUsed < maxRetries) {
				// RETRY: spawn recover-or-skip subagent
				const { retried, nextResult } = await this.retryStep({ stepId, planId, parentThreadId, originalResult: result, retryCount: retriesUsed + 1 });
				if (retried && nextResult) {
					return this.handleCompletion({ stepId, planId, parentThreadId, result: nextResult, retriesUsed: retriesUsed + 1 });
				}
			}

			// Retries exhausted
			const autoSkip = this._config.getValue<boolean>('vibeide.subagent.autoSkipOnRetryExhausted') ?? true;
			const completionStatus: StepCompletionStatus = autoSkip ? 'skipped' : 'paused_for_human';
			record = {
				stepId, planId, parentThreadId,
				status: completionStatus,
				subagentId: result.subagentId,
				subagentStatus: result.status,
				retriesUsed,
				reason: result.reason ?? `Failed after ${retriesUsed} retries`,
				completedAt: Date.now(),
			};
			this._audit.append({ actor: 'subagent', ts: Date.now(), action: 'plan_step_completed', ok: false, meta: { stepId, planId, status: completionStatus, reason: record.reason } });
			this._log.warn(`[SubagentOrchestrator] Step ${stepId} exhausted retries — ${completionStatus}`);

		} else {
			// SKIPPED
			record = {
				stepId, planId, parentThreadId,
				status: 'skipped',
				subagentId: result.subagentId,
				subagentStatus: 'skipped',
				retriesUsed,
				reason: result.reason,
				completedAt: Date.now(),
			};
			this._audit.append({ actor: 'subagent', ts: Date.now(), action: 'plan_step_completed', ok: false, meta: { stepId, planId, status: 'skipped', reason: result.reason } });
		}

		// Record in history
		const planHistory = this._history.get(planId ?? '__global') ?? [];
		planHistory.push(record);
		this._history.set(planId ?? '__global', planHistory);

		return record;
	}

	async retryStep(params: {
		stepId: string;
		planId?: string;
		parentThreadId: string;
		originalResult: SubagentResult;
		retryCount: number;
	}): Promise<{ retried: boolean; nextResult?: SubagentResult }> {
		const { stepId, parentThreadId, originalResult, retryCount } = params;

		this._log.info(`[SubagentOrchestrator] Retry ${retryCount} for step ${stepId} via recover-or-skip subagent`);

		try {
			const subagentId = await this._subagentSvc.spawn({
				parentThreadId,
				type: 'recover-or-skip',
				goal: `Diagnose why step "${stepId}" failed. Original failure: ${originalResult.reason ?? originalResult.summary}. Recommend: retry | skip | escalate.`,
				maxSteps: 10,
				maxWallClockMs: 30_000,
			});

			const nextResult = await this._subagentSvc.awaitResult(subagentId);
			return { retried: true, nextResult };
		} catch (err) {
			this._log.error(`[SubagentOrchestrator] Retry subagent failed to spawn: ${err}`);
			return { retried: false };
		}
	}

	getCompletionHistory(planId: string): StepCompletionRecord[] {
		return [...(this._history.get(planId) ?? [])];
	}

	private async _markStepDone(stepId: string, planId: string | undefined, result: SubagentResult): Promise<void> {
		// Phase 3b: atomic update to .vibe/plans/<planId>.plan.md / .steps.json
		// using IVibePersistedPlanService.writeApprovedAgentPlan (temp+rename).
		// MVP: log the atomic mark operation.
		this._log.info(`[SubagentOrchestrator] Marking step ${stepId} done (plan: ${planId ?? 'none'}; artifacts: ${result.artifacts?.join(',') ?? 'none'})`);
	}
}

registerSingleton(IVibeSubagentOrchestratorService, VibeSubagentOrchestratorService, InstantiationType.Delayed);
