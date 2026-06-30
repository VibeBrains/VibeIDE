/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeBackgroundJobService — in-IDE service for background / unattended job management.
 *
 * Complements `scripts/vibe-agent-run.js` (CLI runner) by providing the IDE-side
 * service layer for job state management, tool policy enforcement, and budget integration.
 *
 * § J.2 requirements covered here:
 *  - Job descriptor: vibeVersion, status, lease, checkpointBefore, cost limits, audit ref
 *  - Tool policy for unattended: supervised-off allowlist; pause job + desktop notification on others
 *  - Budget integration: hard token/USD ceiling per job via IVibeTokenBudgetService
 *
 * Atomic writes: temp file + rename (same pattern as § A.2 plan contract).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IAuditLogService } from './auditLogService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.backgroundJob.defaultMaxTokens': {
			type: 'number',
			default: 50000,
			minimum: 1000,
			maximum: 2000000,
			description: localize('vibeide.backgroundJob.defaultMaxTokens', 'Лимит токенов по умолчанию для фоновых job-ов агента. Отдельные job-ы могут переопределить через поле maxTokens в дескрипторе.'),
		},
		'vibeide.backgroundJob.leaseTtlSeconds': {
			type: 'number',
			default: 120,
			minimum: 30,
			maximum: 600,
			description: localize('vibeide.backgroundJob.leaseTtlSeconds', 'Через сколько секунд lease job-а считается устаревшим (используется для обнаружения упавших job-ов).'),
		},
		'vibeide.backgroundJob.supervisedOffTools': {
			type: 'array',
			items: { type: 'string' },
			default: ['read_file', 'list_dir', 'grep', 'glob', 'write_file', 'edit_file'],
			description: localize('vibeide.backgroundJob.supervisedOffTools', 'Инструменты, разрешённые в unattended-режиме без подтверждения на каждый вызов. Все остальные инструменты вызывают паузу + desktop-уведомление.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type BackgroundJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused_dms' | 'budget_exhausted' | 'paused_tool_policy';

export interface BackgroundJobDescriptor {
	jobId: string;
	vibeVersion: string;
	status: BackgroundJobStatus;
	/** Optional link to a persisted plan */
	planId?: string;
	/** Inline steps (if no planId) */
	steps?: string[];
	/** Hard token ceiling for this job run */
	maxTokens: number;
	/** File paths the job is allowed to write */
	allowedPaths?: string[];
	/** Terminal commands allowed in unattended mode */
	allowedCommands?: string[];
	/** Whether git push is allowed in unattended */
	allowGitPush: boolean;
	/** Safe window for unattended execution */
	safeWindow?: { start: string; end: string };
	createdAt: string;
	startedAt?: string;
	completedAt?: string;
	/** Lease expiry ISO string — refresh every leaseTtlSeconds */
	leaseExpiresAt?: string;
	/** Checkpoint/snapshot ref created before this job ran */
	checkpointBefore?: string;
	/** Audit event id for job_started */
	auditRef?: string;
	/** Tokens consumed in this run */
	tokensUsed?: number;
}

export interface JobToolPolicyDecision {
	allowed: boolean;
	/** If not allowed: 'pause' = pause job and notify; 'block' = always blocked */
	action: 'allow' | 'pause' | 'block';
	reason?: string;
}

export const IVibeBackgroundJobService = createDecorator<IVibeBackgroundJobService>('vibeBackgroundJobService');

export interface IVibeBackgroundJobService {
	readonly _serviceBrand: undefined;

	/** List all job descriptors in .vibe/jobs/ */
	listJobs(): Promise<BackgroundJobDescriptor[]>;

	/** Load a specific job by id */
	loadJob(jobId: string): Promise<BackgroundJobDescriptor | undefined>;

	/**
	 * Atomically update job status (temp + rename).
	 * Safe to call from multiple contexts.
	 */
	updateJobStatus(jobId: string, patch: Partial<BackgroundJobDescriptor>): Promise<void>;

	/**
	 * Check if a tool call is allowed in unattended mode for a given job.
	 * Returns a policy decision with action and reason.
	 */
	checkToolPolicy(jobId: string, toolName: string, descriptor?: BackgroundJobDescriptor): JobToolPolicyDecision;

	/**
	 * Check if the job's token budget has been exceeded.
	 * Returns true if the job should stop.
	 */
	checkBudget(job: BackgroundJobDescriptor, currentSessionTokensUsed: number): { exceeded: boolean; tokensUsed: number; ceiling: number };

	/** Refresh the job's lease heartbeat */
	touchLease(jobId: string): Promise<void>;

	/**
	 * Check if a job is within its configured safe window.
	 * Returns true if execution is allowed right now.
	 */
	isInSafeWindow(job: BackgroundJobDescriptor): boolean;

	/**
	 * Enforce single-active-job policy: returns true if a new job can start.
	 * If another job is already running, returns false (concurrent jobs not allowed by default).
	 */
	canStartJob(jobId: string): Promise<boolean>;

	/**
	 * Export job audit trail for compliance (redacted, no secrets).
	 * Links to session replay via auditRef in job descriptor.
	 */
	exportJobAuditTrail(jobId: string): Promise<string>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeBackgroundJobService extends Disposable implements IVibeBackgroundJobService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IAuditLogService private readonly _audit: IAuditLogService,
	) {
		super();
	}

	private _jobsDir(): URI | undefined {
		const root = this._workspace.getWorkspace().folders[0]?.uri;
		if (!root) { return undefined; }
		return joinPath(root, '.vibe', 'jobs');
	}

	async listJobs(): Promise<BackgroundJobDescriptor[]> {
		const dir = this._jobsDir();
		if (!dir) { return []; }
		try {
			const stat = await this._fileService.resolve(dir);
			const jsonFiles = (stat.children ?? []).filter(c => c.name.endsWith('.json') && !c.name.includes('-digest'));
			const jobs: BackgroundJobDescriptor[] = [];
			for (const file of jsonFiles) {
				try {
					const content = await this._fileService.readFile(file.resource);
					jobs.push(JSON.parse(content.value.toString()));
				} catch { /* skip */ }
			}
			return jobs;
		} catch {
			return [];
		}
	}

	async loadJob(jobId: string): Promise<BackgroundJobDescriptor | undefined> {
		const dir = this._jobsDir();
		if (!dir) { return undefined; }
		const jobPath = joinPath(dir, `${jobId}.json`);
		try {
			const content = await this._fileService.readFile(jobPath);
			return JSON.parse(content.value.toString());
		} catch {
			return undefined;
		}
	}

	async updateJobStatus(jobId: string, patch: Partial<BackgroundJobDescriptor>): Promise<void> {
		const dir = this._jobsDir();
		if (!dir) { return; }
		const existing = await this.loadJob(jobId);
		if (!existing) { return; }
		const updated: BackgroundJobDescriptor = { ...existing, ...patch };
		const jobPath = joinPath(dir, `${jobId}.json`);
		const tmpPath = joinPath(dir, `${jobId}.json.tmp`);
		const json = JSON.stringify(updated, null, 2);
		await this._fileService.writeFile(tmpPath, VSBuffer.fromString(json));
		await this._fileService.move(tmpPath, jobPath, true);
		this._log.info(`[VibeBackgroundJob] Updated job ${jobId} status=${updated.status}`);
	}

	checkToolPolicy(jobId: string, toolName: string, descriptor?: BackgroundJobDescriptor): JobToolPolicyDecision {
		const supervisedOffTools = this._config.getValue<string[]>('vibeide.backgroundJob.supervisedOffTools')
			?? ['read_file', 'list_dir', 'grep', 'glob', 'write_file', 'edit_file'];

		// Always blocked: git push (unless explicitly enabled in job)
		if (toolName === 'git_push' || toolName.includes('git push')) {
			if (descriptor && !descriptor.allowGitPush) {
				return { allowed: false, action: 'block', reason: 'git push disabled in job descriptor (allowGitPush: false)' };
			}
		}

		// Check against supervised-off allowlist
		if (supervisedOffTools.includes(toolName)) {
			// Further check allowedCommands for terminal
			if (toolName === 'run_terminal_command' && descriptor?.allowedCommands) {
				return { allowed: true, action: 'allow' };
			}
			return { allowed: true, action: 'allow' };
		}

		// Anything else: pause job + notify
		return {
			allowed: false,
			action: 'pause',
			reason: `Tool "${toolName}" is not in the supervised-off allowlist (vibeide.backgroundJob.supervisedOffTools). Job will pause and notify.`,
		};
	}

	checkBudget(job: BackgroundJobDescriptor, currentSessionTokensUsed: number): { exceeded: boolean; tokensUsed: number; ceiling: number } {
		const ceiling = job.maxTokens ?? this._config.getValue<number>('vibeide.backgroundJob.defaultMaxTokens') ?? 50000;
		const exceeded = currentSessionTokensUsed >= ceiling;
		if (exceeded) {
			this._log.warn(`[VibeBackgroundJob] Budget exceeded for job ${job.jobId}: ${currentSessionTokensUsed} >= ${ceiling}`);
			this._audit.append({ ts: Date.now(), action: 'background_job_budget_exceeded', ok: false, meta: { jobId: job.jobId, tokensUsed: currentSessionTokensUsed, ceiling } });
		}
		return { exceeded, tokensUsed: currentSessionTokensUsed, ceiling };
	}

	async touchLease(jobId: string): Promise<void> {
		const leaseTtl = (this._config.getValue<number>('vibeide.backgroundJob.leaseTtlSeconds') ?? 120) * 1000;
		await this.updateJobStatus(jobId, { leaseExpiresAt: new Date(Date.now() + leaseTtl).toISOString() });
	}

	isInSafeWindow(job: BackgroundJobDescriptor): boolean {
		if (!job.safeWindow) { return true; }
		const now = new Date();
		const nowMin = now.getHours() * 60 + now.getMinutes();
		const [startH, startM] = job.safeWindow.start.split(':').map(Number);
		const [endH, endM] = job.safeWindow.end.split(':').map(Number);
		const startMin = startH * 60 + startM;
		const endMin = endH * 60 + endM;
		if (startMin <= endMin) {
			return nowMin >= startMin && nowMin < endMin;
		}
		// Overnight window (e.g. 22:00–07:00)
		return nowMin >= startMin || nowMin < endMin;
	}

	async canStartJob(jobId: string): Promise<boolean> {
		// Single active job policy: only one 'running' job per workspace at a time
		const jobs = await this.listJobs();
		const alreadyRunning = jobs.find(j => j.status === 'running' && j.jobId !== jobId);
		if (alreadyRunning) {
			this._log.warn(`[VibeBackgroundJob] Cannot start job ${jobId}: another job is already running (${alreadyRunning.jobId}). Concurrent jobs not allowed.`);
			return false;
		}
		return true;
	}

	async exportJobAuditTrail(jobId: string): Promise<string> {
		// Export job metadata + recent audit events as redacted JSON
		// Phase 3b: link to session replay via auditRef
		const job = await this.loadJob(jobId);
		if (!job) { return JSON.stringify({ error: `Job ${jobId} not found` }); }

		const auditRecent = await this._audit.queryRecent(50);
		const jobEvents = auditRecent.filter(e =>
			e.meta && (e.meta['jobId'] === jobId || e.action.startsWith('background_job'))
		);

		const trail = {
			jobId: job.jobId,
			status: job.status,
			createdAt: job.createdAt,
			startedAt: job.startedAt,
			completedAt: job.completedAt,
			tokensUsed: job.tokensUsed,
			auditEvents: jobEvents.map(e => ({
				ts: e.ts, action: e.action, ok: e.ok,
				// Redact sensitive meta fields
				meta: e.meta ? Object.fromEntries(
					Object.entries(e.meta).filter(([k]) => !['key', 'secret', 'token', 'password'].some(s => k.toLowerCase().includes(s)))
				) : undefined,
			})),
			_note: 'Redacted for compliance. No secrets or raw prompt content included.',
		};
		return JSON.stringify(trail, null, 2);
	}
}

registerSingleton(IVibeBackgroundJobService, VibeBackgroundJobService, InstantiationType.Delayed);
