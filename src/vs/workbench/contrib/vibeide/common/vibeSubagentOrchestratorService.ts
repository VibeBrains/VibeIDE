/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
import { SubagentResult } from './vibeSubagentService.js';
import { IVibeSubagentService } from './vibeSubagentService.js';

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
	) {
		super();
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
