/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { timeout } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { PlanMessage } from './chatThreadServiceTypes.js';
import { ISecretDetectionService } from './secretDetectionService.js';
import { IVibePlanEventJournalService } from './vibePlanEventJournalService.js';

export const IVibePersistedPlanService = createDecorator<IVibePersistedPlanService>('vibePersistedPlanService');

/** Heartbeat older than this ⇒ lease treated as stale (crash / hung renderer). */
export const PLAN_EXECUTION_LEASE_STALE_AFTER_MS = 120_000;

export interface IVibePersistedPlanExecutionLease {
	readonly planId: string;
	readonly threadId: string;
	readonly windowId?: number;
	readonly holderNonce: string;
	readonly startedAt: number;
	readonly lastHeartbeat: number;
}

export type AcquireExecutionLeaseResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly holderThreadId: string };

export interface IVibePersistedPlanService {
	readonly _serviceBrand: undefined;

	plansDirectoryUri(workspaceFolder: URI): URI;

	/** Ensures `.vibe/plans` exists under the workspace folder. */
	ensurePlansDirectory(workspaceFolder: URI): Promise<void>;

	/**
	 * Acquire or refresh `.vibe/plans/.leases/<planId>.json`.
	 * Blocks parallel execution of the same planId from a different chat thread while the lease is fresh.
	 */
	acquireOrRefreshExecutionLease(
		workspaceFolder: URI,
		params: { planId: string; threadId: string; windowId?: number; holderNonce: string },
	): Promise<AcquireExecutionLeaseResult>;

	clearExecutionLease(workspaceFolder: URI, planId: string): Promise<void>;

	readExecutionLease(workspaceFolder: URI, planId: string): Promise<IVibePersistedPlanExecutionLease | undefined>;

	isExecutionLeaseStale(lease: IVibePersistedPlanExecutionLease | undefined): boolean;

	/**
	 * Writes approved agent plan markdown + canonical JSON block. Uses IFileService with bounded retries on transient IO failures.
	 */
	writeApprovedAgentPlan(params: {
		workspaceFolder: URI;
		threadId: string;
		messageIdx: number;
		plan: PlanMessage;
	}): Promise<{ planId: string; uri: URI } | undefined>;

	writePlanMarkdown(uri: URI, content: string): Promise<void>;
}

class VibePersistedPlanService extends Disposable implements IVibePersistedPlanService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ISecretDetectionService private readonly _secretDetection: ISecretDetectionService,
		@IVibePlanEventJournalService private readonly _planEventJournal: IVibePlanEventJournalService,
	) {
		super();
	}

	plansDirectoryUri(workspaceFolder: URI): URI {
		return joinPath(workspaceFolder, '.vibe', 'plans');
	}

	private _leasesDirectoryUri(workspaceFolder: URI): URI {
		return joinPath(this.plansDirectoryUri(workspaceFolder), '.leases');
	}

	private _leaseFileUri(workspaceFolder: URI, planId: string): URI {
		return joinPath(this._leasesDirectoryUri(workspaceFolder), `${planId}.json`);
	}

	async ensurePlansDirectory(workspaceFolder: URI): Promise<void> {
		await this._fileService.createFolder(this.plansDirectoryUri(workspaceFolder));
	}

	async acquireOrRefreshExecutionLease(
		workspaceFolder: URI,
		params: { planId: string; threadId: string; windowId?: number; holderNonce: string },
	): Promise<AcquireExecutionLeaseResult> {
		let existing: IVibePersistedPlanExecutionLease | undefined;
		try {
			existing = await this.readExecutionLease(workspaceFolder, params.planId);
		} catch { /* ignore */ }

		if (existing && !this.isExecutionLeaseStale(existing) && existing.threadId !== params.threadId) {
			return { ok: false, holderThreadId: existing.threadId };
		}

		const startedAt =
			existing && !this.isExecutionLeaseStale(existing) && existing.threadId === params.threadId
				? existing.startedAt
				: Date.now();

		await this.ensurePlansDirectory(workspaceFolder);
		await this._fileService.createFolder(this._leasesDirectoryUri(workspaceFolder));
		const uri = this._leaseFileUri(workspaceFolder, params.planId);
		const lease: IVibePersistedPlanExecutionLease = {
			planId: params.planId,
			threadId: params.threadId,
			windowId: params.windowId,
			holderNonce: params.holderNonce,
			startedAt,
			lastHeartbeat: Date.now(),
		};
		await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(lease, null, 2)));
		return { ok: true };
	}

	async clearExecutionLease(workspaceFolder: URI, planId: string): Promise<void> {
		const uri = this._leaseFileUri(workspaceFolder, planId);
		try {
			await this._fileService.del(uri);
		} catch {
			// missing lease is fine
		}
	}

	async readExecutionLease(workspaceFolder: URI, planId: string): Promise<IVibePersistedPlanExecutionLease | undefined> {
		const uri = this._leaseFileUri(workspaceFolder, planId);
		try {
			const raw = (await this._fileService.readFile(uri)).value.toString();
			const obj = JSON.parse(raw) as Partial<IVibePersistedPlanExecutionLease>;
			if (typeof obj.planId !== 'string' || typeof obj.threadId !== 'string' || typeof obj.holderNonce !== 'string') {
				return undefined;
			}
			if (typeof obj.startedAt !== 'number' || typeof obj.lastHeartbeat !== 'number') {
				return undefined;
			}
			return {
				planId: obj.planId,
				threadId: obj.threadId,
				windowId: typeof obj.windowId === 'number' ? obj.windowId : undefined,
				holderNonce: obj.holderNonce,
				startedAt: obj.startedAt,
				lastHeartbeat: obj.lastHeartbeat,
			};
		} catch {
			return undefined;
		}
	}

	isExecutionLeaseStale(lease: IVibePersistedPlanExecutionLease | undefined): boolean {
		if (!lease) {
			return true;
		}
		return Date.now() - lease.lastHeartbeat > PLAN_EXECUTION_LEASE_STALE_AFTER_MS;
	}

	async writeApprovedAgentPlan(params: {
		workspaceFolder: URI;
		threadId: string;
		messageIdx: number;
		plan: PlanMessage;
	}): Promise<{ planId: string; uri: URI } | undefined> {
		await this.ensurePlansDirectory(params.workspaceFolder);
		const plansDir = this.plansDirectoryUri(params.workspaceFolder);
		const planId = generateUuid();
		const stamp = Date.now();
		const createdAt = new Date(stamp).toISOString();
		const fileName = `agent-plan-${planId.slice(0, 8)}-${stamp}.plan.md`;
		const uri = joinPath(plansDir, fileName);

		const machine = {
			planKind: 'vibeide.agent-plan',
			vibeVersion: '1',
			planId,
			status: 'running',
			createdAt,
			workspaceRootUri: params.workspaceFolder.toString(true),
			boundThreadId: params.threadId,
			planMessageIdx: params.messageIdx,
			steps: params.plan.steps.map(s => ({
				stepNumber: s.stepNumber,
				description: s.description,
				tools: s.tools,
				files: s.files,
				status: s.disabled ? 'skipped' : (s.status ?? 'queued'),
				disabled: !!s.disabled,
				checkpointIdx: s.checkpointIdx ?? undefined,
				worktreeBranch: s.worktreeBranch,
				explorationId: s.explorationId,
			})),
		};

		const stepsMd = params.plan.steps
			.map(s =>
				s.disabled
					? `- ~~Step ${s.stepNumber}:~~ ${s.description} _(skipped)_`
					: `- [ ] Step ${s.stepNumber}: ${s.description}`
			)
			.join('\n');

		const text = [
			'---',
			`planId: "${planId}"`,
			'vibeVersion: "1"',
			`status: running`,
			`createdAt: "${createdAt}"`,
			`boundThreadId: "${params.threadId}"`,
			`planMessageIdx: ${params.messageIdx}`,
			'---',
			'',
			`## Summary`,
			'',
			params.plan.summary.trim() || '(no summary)',
			'',
			`## Steps`,
			'',
			stepsMd || '_(none)_',
			'',
			'<!-- vibe-plan-machine-context: JSON canonical for tooling / resume (Phase 3) -->',
			'```json',
			JSON.stringify(machine, null, 2),
			'```',
			'',
		].join('\n');

		let outText = text;
		const secCfg = this._secretDetection.getConfig();
		if (secCfg.enabled) {
			const det = this._secretDetection.detectSecrets(text);
			if (det.hasSecrets) {
				if (secCfg.mode === 'block') {
					vibeLog.warn('vibePersistedPlan', '[VibePersistedPlan] Refusing to write plan file: secret detection (block mode).');
					throw new Error('VibeIDE: Plan file blocked: secret-like content detected. Remove secrets from the plan or set vibeide.secretDetection.mode to redact.');
				}
				outText = det.redactedText;
			}
		}

		await this.writePlanMarkdown(uri, outText);
		vibeLog.info('vibePersistedPlan', `[VibePersistedPlan] wrote approved agent plan: ${uri.fsPath}`);
		void this._planEventJournal.append(params.workspaceFolder, {
			type: 'plan.created',
			planId,
			threadId: params.threadId,
			planMessageIdx: params.messageIdx,
			stepsTotal: params.plan.steps.length,
			artifactUri: uri.toString(true),
		});
		return { planId, uri };
	}

	async writePlanMarkdown(uri: URI, content: string): Promise<void> {
		const buf = VSBuffer.fromString(content);
		let lastErr: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await this._fileService.writeFile(uri, buf);
				return;
			} catch (e) {
				lastErr = e;
				vibeLog.warn('vibePersistedPlan', '[VibePersistedPlan] writePlanMarkdown retry', uri.toString(true), attempt + 1, e);
				await timeout(80 * (attempt + 1));
			}
		}
		throw lastErr;
	}
}

registerSingleton(IVibePersistedPlanService, VibePersistedPlanService, InstantiationType.Eager);
