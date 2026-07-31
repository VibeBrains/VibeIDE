/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Durable ledger of agent runs in `.vibe/agent-runs.jsonl`.
 *
 * The live subagent registry dies with the window; this service is what remains. It owns the
 * file and the window's identity (epoch + fence), while every decision about the content lives
 * in the pure `agentRunLedger` / `agentRunFence` modules.
 *
 * Sits in `common/` alongside `auditLogService`, which solves the same shape of problem — JSONL
 * under `.vibe/` through `IFileService` — and needs nothing from `browser` or `node`.
 *
 * On startup the window claims a fresh epoch, marks runs abandoned by windows that stopped
 * beating, prunes what aged out and rewrites the file compacted. While it lives it beats every
 * `HEARTBEAT_INTERVAL_MS` so a second window on the same workspace is never mistaken for a dead
 * one — the mistake that would make the whole "who is working" readout lie.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IntervalTimer, RunOnceScheduler } from '../../../../base/common/async.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { vibeLog } from './vibeLog.js';
import { AgentRunFence, formatAgentRunEpoch, nextAgentRunFence } from './agentRunFence.js';
import {
	AgentRunRecord, AgentRunSummary, AgentRunUpdate, compactAgentRunLog, isTerminalRunStatus,
	markOrphanedRuns, parseAgentRunLog, pruneAgentRuns, serializeAgentRunUpdate, summariseAgentRuns,
} from './agentRunLedger.js';

// ── Configuration ─────────────────────────────────────────────────────────────

const CONFIG_ENABLE = 'vibeide.agents.ledger.enable';
const CONFIG_MAX_RECORDS = 'vibeide.agents.ledger.maxRecords';
const CONFIG_RETENTION_DAYS = 'vibeide.agents.ledger.retentionDays';

const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_RETENTION_DAYS = 30;

/** How often a live window signs the runs it owns. Internal cadence, not a user-facing knob. */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Silence longer than three missed beats means the window is gone, not busy. */
const STALE_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;
/** Batches bursts of updates into one file write, mirroring the audit log. */
const WRITE_DEBOUNCE_MS = 100;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	title: localize('vibeide.agents.ledger.title', "VibeIDE — журнал прогонов агентов"),
	type: 'object',
	properties: {
		[CONFIG_ENABLE]: {
			type: 'boolean',
			default: true,
			description: localize('vibeide.agents.ledger.enable', "Вести журнал прогонов агентов в .vibe/agent-runs.jsonl. Журнал переживает перезапуск и питает панель «Диспетчерская агентов». Промпты и переписка в него не попадают — только метаданные прогона."),
		},
		[CONFIG_MAX_RECORDS]: {
			type: 'number',
			default: DEFAULT_MAX_RECORDS,
			minimum: 0,
			description: localize('vibeide.agents.ledger.maxRecords', "Сколько завершённых прогонов хранить. Незавершённые не удаляются никогда. 0 — не ограничивать по количеству."),
		},
		[CONFIG_RETENTION_DAYS]: {
			type: 'number',
			default: DEFAULT_RETENTION_DAYS,
			minimum: 0,
			description: localize('vibeide.agents.ledger.retentionDays', "Через сколько дней забывать завершённый прогон. 0 — хранить бессрочно."),
		},
	},
});

// ── Service ───────────────────────────────────────────────────────────────────

export const IVibeAgentRunLedgerService = createDecorator<IVibeAgentRunLedgerService>('vibeAgentRunLedgerService');

export interface IVibeAgentRunLedgerService {
	readonly _serviceBrand: undefined;

	/** Identity of this window's lifetime — stamped on every run it starts. */
	readonly epoch: string;

	isEnabled(): boolean;

	/** Ownership token for a new run. Monotonic inside the window, ordered across windows. */
	allocateFence(): AgentRunFence;

	/** Record a run that just started. */
	recordStarted(record: AgentRunRecord): void;

	/** Record a change to a known run — status, outcome, spend. */
	recordUpdate(update: AgentRunUpdate): void;

	/** Everything the ledger knows, freshly read from disk. */
	getRuns(): Promise<readonly AgentRunRecord[]>;

	getSummary(): Promise<AgentRunSummary>;

	/** Fired after this window changes the ledger. */
	readonly onDidChangeRuns: Event<void>;
}

class VibeAgentRunLedgerService extends Disposable implements IVibeAgentRunLedgerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRuns = this._register(new Emitter<void>());
	readonly onDidChangeRuns: Event<void> = this._onDidChangeRuns.event;

	readonly epoch: string;

	private readonly _windowStartedAtMs = Date.now();
	private _lastSeq = 0;

	private _pending: AgentRunUpdate[] = [];
	private readonly _writeScheduler: RunOnceScheduler;
	private readonly _heartbeat = this._register(new IntervalTimer());

	/** Runs this window started and has not closed — the set the heartbeat signs. */
	private readonly _ownLiveRunIds = new Set<string>();

	/** Serialises read-modify-write cycles so two flushes cannot interleave on one file. */
	private _writeChain: Promise<void> = Promise.resolve();
	private _startupDone: Promise<void> | undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
		this.epoch = formatAgentRunEpoch(this._windowStartedAtMs, Math.random().toString(36).slice(2, 8));
		this._writeScheduler = this._register(new RunOnceScheduler(() => this._flush(), WRITE_DEBOUNCE_MS));
		this._heartbeat.cancelAndSet(() => this._beat(), HEARTBEAT_INTERVAL_MS);
	}

	isEnabled(): boolean {
		return this._configurationService.getValue<boolean>(CONFIG_ENABLE) ?? true;
	}

	allocateFence(): AgentRunFence {
		const fence = nextAgentRunFence(this._windowStartedAtMs, this._lastSeq);
		this._lastSeq = fence.seq;
		return fence;
	}

	recordStarted(record: AgentRunRecord): void {
		if (!this.isEnabled()) {
			return;
		}
		this._ownLiveRunIds.add(record.runId);
		this._enqueue({ ...record, lastSeenAt: Date.now() });
	}

	recordUpdate(update: AgentRunUpdate): void {
		if (!this.isEnabled()) {
			return;
		}
		if (update.status && isTerminalRunStatus(update.status)) {
			this._ownLiveRunIds.delete(update.runId);
		}
		this._enqueue({ lastSeenAt: Date.now(), ...update });
	}

	async getRuns(): Promise<readonly AgentRunRecord[]> {
		const path = this._logPath();
		if (!path) {
			return [];
		}
		await this._startup();
		await this._settled();
		const parsed = parseAgentRunLog(await this._read(path));
		if (parsed.malformedLines > 0) {
			vibeLog.warn('agentRunLedger', `agent-runs.jsonl: ${parsed.malformedLines} нечитаемых строк пропущено`);
		}
		return parsed.records;
	}

	async getSummary(): Promise<AgentRunSummary> {
		return summariseAgentRuns(await this.getRuns());
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private _logPath(): URI | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? joinPath(folders[0].uri, '.vibe', 'agent-runs.jsonl') : undefined;
	}

	private _enqueue(update: AgentRunUpdate): void {
		this._pending.push(update);
		this._writeScheduler.schedule();
	}

	/**
	 * Sign the runs this window still owns. Without it a second window would eventually see our
	 * runs as abandoned and mark them orphaned while they are working.
	 */
	private _beat(): void {
		if (!this.isEnabled() || this._ownLiveRunIds.size === 0) {
			return;
		}
		const now = Date.now();
		for (const runId of this._ownLiveRunIds) {
			this._pending.push({ runId, lastSeenAt: now });
		}
		this._writeScheduler.schedule();
	}

	/**
	 * One-time claim of the file: adopt abandoned runs, drop what aged out, rewrite compacted.
	 * Runs before the first write so a stale record can never be revived by our own append.
	 */
	private _startup(): Promise<void> {
		if (!this._startupDone) {
			this._startupDone = this._serialise(async path => {
				const parsed = parseAgentRunLog(await this._read(path));
				const { records, orphanedIds } = markOrphanedRuns(parsed.records, this.epoch, Date.now(), STALE_AFTER_MS);
				const pruned = pruneAgentRuns(records, {
					maxRecords: this._configurationService.getValue<number>(CONFIG_MAX_RECORDS) ?? DEFAULT_MAX_RECORDS,
					retentionDays: this._configurationService.getValue<number>(CONFIG_RETENTION_DAYS) ?? DEFAULT_RETENTION_DAYS,
					now: Date.now(),
				});
				if (orphanedIds.length > 0) {
					vibeLog.info('agentRunLedger', `осиротевшие прогоны помечены: ${orphanedIds.join(', ')}`);
				}
				if (orphanedIds.length > 0 || pruned.length !== parsed.records.length) {
					await this._write(path, compactAgentRunLog(pruned));
				}
			});
		}
		return this._startupDone;
	}

	private async _flush(): Promise<void> {
		if (this._pending.length === 0) {
			return;
		}
		await this._startup();
		const updates = this._pending.splice(0);
		await this._serialise(async path => {
			const existing = await this._read(path);
			const appended = updates.map(update => serializeAgentRunUpdate(update)).join('\n') + '\n';
			await this._write(path, existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n${appended}` : existing + appended);
		});
		this._onDidChangeRuns.fire();
	}

	/** Resolves once every queued write has landed — read paths wait on it before parsing. */
	private async _settled(): Promise<void> {
		if (this._pending.length > 0) {
			await this._flush();
		}
		await this._writeChain;
	}

	private _serialise(operation: (path: URI) => Promise<void>): Promise<void> {
		const path = this._logPath();
		if (!path) {
			return Promise.resolve();
		}
		this._writeChain = this._writeChain.then(async () => {
			try {
				await operation(path);
			} catch (error) {
				vibeLog.error('agentRunLedger', 'не удалось обновить agent-runs.jsonl', error);
			}
		});
		return this._writeChain;
	}

	private async _read(path: URI): Promise<string> {
		try {
			return (await this._fileService.readFile(path)).value.toString();
		} catch {
			// Absent on first run — an empty ledger is the correct starting point.
			return '';
		}
	}

	private async _write(path: URI, contents: string): Promise<void> {
		await this._fileService.writeFile(path, VSBuffer.fromString(contents), { atomic: { postfix: '.vibe-tmp' } });
	}
}

registerSingleton(IVibeAgentRunLedgerService, VibeAgentRunLedgerService, InstantiationType.Delayed);
