/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { isModelSubstituted } from './modelEcho.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { timeout } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import type { PlanMessage, PlanStep } from './chatThreadServiceTypes.js';
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

/** Lifecycle status written into the persisted plan file (frontmatter + JSON canonical). */
export type PersistedPlanStatus = 'running' | 'completed' | 'failed' | 'paused';

interface PlanFileMeta {
	readonly planId: string;
	readonly threadId: string;
	readonly messageIdx: number;
	readonly createdAt: string;
	readonly workspaceRootUri?: string;
	/** The model the plan was approved on — see `planModelDrift`. Absent in files written before it existed. */
	readonly plannedModel?: PlannedModel;
	/** Models that actually answered while the plan ran — see `planModelDrift`. */
	readonly servedModels?: readonly PlannedModel[];
}

/** Provider and model a plan was approved on. */
export interface PlannedModel {
	readonly provider: string;
	readonly model: string;
}

/** Why resuming a plan is not quite resuming it where it stopped. */
export type PlanModelDrift =
	/** The chat now runs another model than the one that approved the plan. */
	| { readonly kind: 'model-changed'; readonly planned: PlannedModel; readonly current: PlannedModel }
	/** The provider the plan was approved on has no usable key any more — rotated or removed. */
	| { readonly kind: 'provider-unavailable'; readonly planned: PlannedModel }
	/** The plan ran, but other models answered: a proxy, an aggregator or a failover target served them. */
	| { readonly kind: 'served-other'; readonly planned: PlannedModel; readonly served: readonly PlannedModel[] };

/**
 * What changed between approving a plan and resuming it, as far as the model goes.
 *
 * WHY this is said out loud: a plan survives a restart, but it does not carry its model with it —
 * resuming continues on whatever the chat has selected NOW. A plan approved on one model and
 * finished by another is two different pieces of work under one name, and nothing told the person
 * that happened. A plan file without a recorded model (written before this existed) reports
 * nothing: an unknown past is not a change.
 *
 * Pure: the caller supplies the current selection and whether the planned provider still has a key.
 */
export function planModelDrift(planned: PlannedModel | undefined, current: PlannedModel | undefined, plannedProviderUsable: boolean, served: readonly PlannedModel[] = []): PlanModelDrift[] {
	if (!planned) {
		return [];
	}
	const drift: PlanModelDrift[] = [];
	if (current && (current.provider !== planned.provider || current.model !== planned.model)) {
		drift.push({ kind: 'model-changed', planned, current });
	}
	if (!plannedProviderUsable) {
		drift.push({ kind: 'provider-unavailable', planned });
	}
	// Another spelling of the same model (an aggregator prefix, a dated build) is not a substitution.
	const others = served.filter(s => s.provider !== planned.provider || isModelSubstituted(planned.model, s.model));
	if (others.length > 0) {
		drift.push({ kind: 'served-other', planned, served: others });
	}
	return drift;
}

/** How many distinct answering models a plan keeps; a failover storm must not grow the file without bound. */
const MAX_SERVED_MODELS = 16;

/** Stored `servedModels`, read defensively like `plannedModel`. */
export function parseServedModels(value: unknown): PlannedModel[] {
	return Array.isArray(value) ? value.map(parsePlannedModel).filter((m): m is PlannedModel => m !== undefined).slice(0, MAX_SERVED_MODELS) : [];
}

/** The union of two lists of answering models, first seen first, capped. */
export function mergeServedModels(known: readonly PlannedModel[] | undefined, added: readonly PlannedModel[] | undefined): PlannedModel[] {
	const out: PlannedModel[] = [];
	for (const m of [...(known ?? []), ...(added ?? [])]) {
		if (out.length < MAX_SERVED_MODELS && !out.some(o => o.provider === m.provider && o.model === m.model)) {
			out.push(m);
		}
	}
	return out;
}

/**
 * Pure serializer for an agent plan file (frontmatter + human-readable steps + JSON canonical).
 * Step statuses are reflected in BOTH the markdown checkboxes (`[x]` succeeded, `[ ]` pending,
 * `_(failed)_`, `~~skipped~~`) and `steps[].status` in the JSON block, and the top-level `status`
 * is the caller-supplied lifecycle state. So a finished plan writes `[x]` + `status: completed`
 * instead of a frozen `[ ]` + `running` snapshot. Used at creation (status='running') and on every
 * progress/finalization update.
 */
/** A stored `plannedModel`, read defensively: plan files are hand-editable and outlive this code. */
export function parsePlannedModel(value: unknown): PlannedModel | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as { provider?: unknown; model?: unknown };
	return typeof candidate.provider === 'string' && candidate.provider && typeof candidate.model === 'string' && candidate.model
		? { provider: candidate.provider, model: candidate.model }
		: undefined;
}

export function serializePlanMarkdown(plan: PlanMessage, meta: PlanFileMeta, status: PersistedPlanStatus): string {
	const machine = {
		planKind: 'vibeide.agent-plan',
		vibeVersion: '1',
		planId: meta.planId,
		status,
		createdAt: meta.createdAt,
		workspaceRootUri: meta.workspaceRootUri,
		boundThreadId: meta.threadId,
		planMessageIdx: meta.messageIdx,
		plannedModel: meta.plannedModel,
		servedModels: meta.servedModels && meta.servedModels.length > 0 ? meta.servedModels : undefined,
		steps: plan.steps.map(s => ({
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
	// Drop the undefined placeholder so we don't emit `"workspaceRootUri": null`.
	if (machine.workspaceRootUri === undefined) { delete (machine as { workspaceRootUri?: string }).workspaceRootUri; }

	const stepLine = (s: PlanStep): string => {
		if (s.disabled || s.status === 'skipped') {
			return `- ~~Step ${s.stepNumber}:~~ ${s.description} _(skipped)_`;
		}
		if (s.status === 'succeeded') {
			return `- [x] Step ${s.stepNumber}: ${s.description}`;
		}
		if (s.status === 'failed') {
			return `- [ ] Step ${s.stepNumber}: ${s.description} _(failed)_`;
		}
		return `- [ ] Step ${s.stepNumber}: ${s.description}`;
	};
	const stepsMd = plan.steps.map(stepLine).join('\n');

	return [
		'---',
		`planId: "${meta.planId}"`,
		'vibeVersion: "1"',
		`status: ${status}`,
		`createdAt: "${meta.createdAt}"`,
		`boundThreadId: "${meta.threadId}"`,
		`planMessageIdx: ${meta.messageIdx}`,
		'---',
		'',
		`## Summary`,
		'',
		plan.summary.trim() || '(no summary)',
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
}

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
		plannedModel?: PlannedModel;
	}): Promise<{ planId: string; uri: URI } | undefined>;

	writePlanMarkdown(uri: URI, content: string): Promise<void>;

	/**
	 * Re-write an EXISTING plan file to reflect current step statuses + lifecycle `status`
	 * (running → completed/failed) WITHOUT minting a new planId/file. Resolves the file by globbing
	 * `agent-plan-<planId-prefix>-*.plan.md`, preserves `createdAt`/`boundThreadId`/`planMessageIdx`
	 * from the existing file. No-op (logged) if the file is missing/unparseable — progress
	 * persistence must never break execution.
	 */
	updatePersistedPlanProgress(params: {
		workspaceFolder: URI;
		planId: string;
		plan: PlanMessage;
		status: PersistedPlanStatus;
		/** Models that answered since the last write; merged into the ones the file already lists. */
		servedModels?: readonly PlannedModel[];
	}): Promise<void>;
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
		/** The chat model at approval; absent when it was `auto`, which names no model to compare with. */
		plannedModel?: PlannedModel;
	}): Promise<{ planId: string; uri: URI } | undefined> {
		await this.ensurePlansDirectory(params.workspaceFolder);
		const plansDir = this.plansDirectoryUri(params.workspaceFolder);
		const planId = generateUuid();
		const stamp = Date.now();
		const createdAt = new Date(stamp).toISOString();
		const fileName = `agent-plan-${planId.slice(0, 8)}-${stamp}.plan.md`;
		const uri = joinPath(plansDir, fileName);

		const text = serializePlanMarkdown(
			params.plan,
			{ planId, threadId: params.threadId, messageIdx: params.messageIdx, createdAt, workspaceRootUri: params.workspaceFolder.toString(true), plannedModel: params.plannedModel },
			'running',
		);

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

	async updatePersistedPlanProgress(params: {
		workspaceFolder: URI;
		planId: string;
		plan: PlanMessage;
		status: PersistedPlanStatus;
		servedModels?: readonly PlannedModel[];
	}): Promise<void> {
		try {
			const uri = await this._resolvePlanFileUri(params.workspaceFolder, params.planId);
			if (!uri) {
				vibeLog.warn('vibePersistedPlan', `[VibePersistedPlan] updateProgress: plan file not found for ${params.planId} — skipping.`);
				return;
			}
			// Preserve createdAt / threadId / messageIdx / workspaceRootUri from the existing file so
			// the update is a faithful re-write, not a metadata reset.
			const existing = await this._fileService.readFile(uri);
			const meta = this._parsePlanFileMeta(existing.value.toString(), params.planId);
			if (!meta) {
				vibeLog.warn('vibePersistedPlan', `[VibePersistedPlan] updateProgress: could not parse meta for ${uri.fsPath} — skipping.`);
				return;
			}
			const text = serializePlanMarkdown(params.plan, { ...meta, servedModels: mergeServedModels(meta.servedModels, params.servedModels) }, params.status);
			let outText = text;
			const secCfg = this._secretDetection.getConfig();
			if (secCfg.enabled) {
				const det = this._secretDetection.detectSecrets(text);
				if (det.hasSecrets) {
					if (secCfg.mode === 'block') {
						vibeLog.warn('vibePersistedPlan', '[VibePersistedPlan] updateProgress: secret detected (block mode) — skipping write.');
						return;
					}
					outText = det.redactedText;
				}
			}
			await this.writePlanMarkdown(uri, outText);
			vibeLog.info('vibePersistedPlan', `[VibePersistedPlan] updated plan progress: ${uri.fsPath} → status=${params.status}`);
		} catch (e) {
			vibeLog.warn('vibePersistedPlan', `[VibePersistedPlan] updateProgress failed for ${params.planId}`, e);
		}
	}

	/** Find the on-disk plan file for a planId by its filename prefix. Undefined if absent. */
	private async _resolvePlanFileUri(workspaceFolder: URI, planId: string): Promise<URI | undefined> {
		try {
			const dir = this.plansDirectoryUri(workspaceFolder);
			const stat = await this._fileService.resolve(dir);
			const prefix = `agent-plan-${planId.slice(0, 8)}-`;
			const match = stat.children?.find(c => !c.isDirectory && c.name.startsWith(prefix) && c.name.endsWith('.plan.md'));
			return match?.resource;
		} catch {
			return undefined;
		}
	}

	/** Parse authoritative metadata from the JSON canonical block of a plan file. */
	private _parsePlanFileMeta(content: string, planId: string): PlanFileMeta | undefined {
		const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
		if (!jsonMatch) { return undefined; }
		try {
			const m = JSON.parse(jsonMatch[1]) as { planId?: string; createdAt?: string; boundThreadId?: string; planMessageIdx?: number; workspaceRootUri?: string; plannedModel?: unknown; servedModels?: unknown };
			if (typeof m.createdAt === 'string' && typeof m.boundThreadId === 'string' && typeof m.planMessageIdx === 'number') {
				// Carried through every progress rewrite: dropping it here would erase the approval model
				// on the first step update, and the resume check would silently stop working.
				return { planId: m.planId ?? planId, threadId: m.boundThreadId, messageIdx: m.planMessageIdx, createdAt: m.createdAt, workspaceRootUri: m.workspaceRootUri, plannedModel: parsePlannedModel(m.plannedModel), servedModels: parseServedModels(m.servedModels) };
			}
		} catch { /* fall through */ }
		return undefined;
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
