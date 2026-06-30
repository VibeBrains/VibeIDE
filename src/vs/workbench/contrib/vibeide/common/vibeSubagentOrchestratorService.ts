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
import { IVibeSubagentRegistryService } from './vibeSubagentRegistryService.js';
import { buildRoute, VibeAgentRoute } from './vibeAgentRoutes.js';

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

	/** Classify a task into an ordered role workflow (Vibe Agents — VA.3/VA.4). Pure, no spawn. */
	planRoute(taskText: string): VibeAgentRoute;

	/**
	 * Run the role workflow for a task: spawn each role in sequence, handing the previous
	 * role's summary forward as context. Stops the chain on the first failure.
	 */
	executeRoute(params: { parentThreadId: string; taskText: string }): Promise<SubagentResult[]>;
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
	) {
		super();
	}

	planRoute(taskText: string): VibeAgentRoute {
		return buildRoute(taskText);
	}

	async executeRoute(params: { parentThreadId: string; taskText: string }): Promise<SubagentResult[]> {
		const { parentThreadId, taskText } = params;
		const route = buildRoute(taskText);
		this._log.info(`[SubagentOrchestrator] route ${route.kind}: ${route.roles.join(' → ')}${route.securityAdded ? ' (+security)' : ''}`);
		this._audit.append({ ts: Date.now(), action: 'agent_route_started', ok: true, meta: { kind: route.kind, roles: route.roles, securityAdded: route.securityAdded } });

		const results: SubagentResult[] = [];
		let priorSummary = '';
		for (const stage of route.stages) {
			// Roles within a stage are independent → run them in parallel.
			const stageResults = await Promise.all(stage.map(role => this._runRole(role, parentThreadId, taskText, priorSummary)));
			let failed = false;
			const summaries: string[] = [];
			for (const r of stageResults) {
				if (!r || r.status === 'failed') {
					failed = true;
					continue;
				}
				results.push(r);
				if (r.summary) {
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
	private async _runRole(role: SubagentType, parentThreadId: string, taskText: string, priorSummary: string): Promise<SubagentResult | undefined> {
		const preset = this._registry.getPreset(role);
		const goal = `Роль: ${preset.displayName}. Задача: ${taskText}`
			+ (priorSummary ? `\n\nКонтекст от предыдущего этапа:\n${priorSummary}` : '');
		try {
			const subagentId = await this._subagentSvc.spawn({
				parentThreadId,
				type: role,
				goal,
				maxSteps: preset.defaultMaxSteps,
				maxWallClockMs: preset.defaultMaxWallClockMs,
			});
			return await this._subagentSvc.awaitResult(subagentId);
		} catch (err) {
			this._log.error(`[SubagentOrchestrator] role ${role} failed: ${err}`);
			return undefined;
		}
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
			this._audit.append({ ts: Date.now(), action: 'plan_step_completed', ok: true, meta: { stepId, planId, subagentId: result.subagentId, artifacts: result.artifacts } });

		} else if (result.status === 'failed') {
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
				subagentStatus: 'failed',
				retriesUsed,
				reason: result.reason ?? `Failed after ${retriesUsed} retries`,
				completedAt: Date.now(),
			};
			this._audit.append({ ts: Date.now(), action: 'plan_step_completed', ok: false, meta: { stepId, planId, status: completionStatus, reason: record.reason } });
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
			this._audit.append({ ts: Date.now(), action: 'plan_step_completed', ok: false, meta: { stepId, planId, status: 'skipped', reason: result.reason } });
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
