/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Agent-run ledger — the durable answer to "who did what".
 *
 * The live subagent registry is a `Map` that dies with the window, and `disposeSubagent` drops
 * the entry the moment a run is released — so the only trace of a finished run used to be a log
 * line. This module is the record instead: an append-only JSONL log where each line is a partial
 * update and a run is the fold of its updates, in file order.
 *
 * Only milestones are written — start, finish, orphaning. Per-hop progress stays in memory
 * (`SubagentEntry.liveTokensUsed` and friends): a ledger is a record of what happened, not a
 * telemetry stream, and appending on every hop would rewrite the file dozens of times per run.
 *
 * Prompts, transcripts and tool arguments never enter a record — goals and summaries are already
 * bounded by the subagent handoff contract, and everything else here is metadata.
 *
 * Pure and I/O-free: the service reads the file, hands the text over, and writes back what these
 * functions return. Everything below is exercised from `test/common/` without a workbench.
 */

import { AgentRunFence, isAgentRunFence } from './agentRunFence.js';

/** Bumped only when a line shape stops being readable by the previous parser. */
export const AGENT_RUN_LOG_VERSION = 1;

export type AgentRunStatus =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'stopped'
	| 'skipped'
	/** The owning window went away without closing the run — see `markOrphanedRuns`. */
	| 'orphaned';

const RUN_STATUSES: readonly AgentRunStatus[] = ['pending', 'running', 'completed', 'failed', 'stopped', 'skipped', 'orphaned'];
const TERMINAL_STATUSES: ReadonlySet<AgentRunStatus> = new Set<AgentRunStatus>(['completed', 'failed', 'stopped', 'skipped', 'orphaned']);
/** Stop codes that mean the run hit a ceiling rather than failing — surfaced as "упёрся в лимит". */
const LIMIT_STOP_CODES: ReadonlySet<string> = new Set(['max-steps', 'deadline', 'token-budget']);

export interface AgentRunRecord {
	readonly runId: string;
	/** Window lifetime that owns the run — see `agentRunFence`. */
	readonly epoch: string;
	readonly fence: AgentRunFence;
	/** Subagent role (`SubagentType`), kept as a plain string so the ledger survives role renames. */
	readonly role: string;
	readonly goal: string;
	readonly parentThreadId: string;
	readonly status: AgentRunStatus;
	readonly startedAt: number;
	/**
	 * Heartbeat from the owning window. A foreign epoch alone does not mean abandoned — two
	 * windows on one workspace are legal — so liveness is what separates "someone else is
	 * working" from "nobody is left".
	 */
	readonly lastSeenAt?: number;
	readonly endedAt?: number;
	readonly tokensUsed?: number;
	/** Prompt-cache reads inside `tokensUsed` — what the run did NOT pay for a second time. */
	readonly cachedTokens?: number;
	readonly tokenQuota?: number;
	readonly stepsDone?: number;
	readonly maxSteps?: number;
	/** Files the run changed, as workspace-relative paths. */
	readonly artifacts?: readonly string[];
	/** `SubagentStopReason` when a limit ended the run. */
	readonly stopCode?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly summary?: string;
	/** Session-compatibility digest — see `agentRunFingerprint`. */
	readonly fingerprint?: string;
	/** `AgentSessionMismatch` explaining why this run did not resume an earlier session. */
	readonly resumeReason?: string;
	/** Set when this run is a replay of an earlier one — the pair the comparison report reads. */
	readonly replayOfRunId?: string;
	readonly failureReason?: string;
}

/** One line of the log: whatever changed, addressed by `runId`. */
export type AgentRunUpdate = Partial<Omit<AgentRunRecord, 'runId'>> & { readonly runId: string };

export interface AgentRunLogParseResult {
	/** Folded runs, in order of first appearance. */
	readonly records: readonly AgentRunRecord[];
	/** Lines that were unreadable or never completed a run — reported, never silently dropped. */
	readonly malformedLines: number;
}

export interface AgentRunSummary {
	readonly total: number;
	/** Runs still believed to be working. */
	readonly live: number;
	readonly orphaned: number;
	readonly failed: number;
	/** Runs stopped by a step / deadline / token ceiling. */
	readonly limited: number;
	readonly tokensTotal: number;
}

export interface AgentRunPruneOptions {
	readonly maxRecords: number;
	readonly retentionDays: number;
	readonly now: number;
}

/** Whether a stop code means "hit a ceiling" rather than "broke" — see {@link LIMIT_STOP_CODES}. */
export function isLimitStopCode(stopCode: string | undefined): boolean {
	return !!stopCode && LIMIT_STOP_CODES.has(stopCode);
}

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

/** One JSONL line for an update. The caller adds the newline and writes it. */
export function serializeAgentRunUpdate(update: AgentRunUpdate): string {
	return JSON.stringify({ v: AGENT_RUN_LOG_VERSION, ...update });
}

/** Whole log as JSONL, one line per record — used after pruning rewrites the file. */
export function compactAgentRunLog(records: readonly AgentRunRecord[]): string {
	if (records.length === 0) {
		return '';
	}
	return records.map(record => serializeAgentRunUpdate(record)).join('\n') + '\n';
}

/**
 * Fold the log into runs. A run appears once its updates have supplied every required field;
 * lines addressing a run that never got them count as malformed rather than producing a
 * half-record the UI would have to defend against.
 */
export function parseAgentRunLog(raw: string): AgentRunLogParseResult {
	const folded = new Map<string, Partial<AgentRunRecord>>();
	const order: string[] = [];
	let malformedLines = 0;

	for (const line of raw.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		const update = decodeUpdate(trimmed);
		if (!update) {
			malformedLines++;
			continue;
		}
		if (!folded.has(update.runId)) {
			folded.set(update.runId, {});
			order.push(update.runId);
		}
		folded.set(update.runId, { ...folded.get(update.runId), ...update });
	}

	const records: AgentRunRecord[] = [];
	for (const runId of order) {
		const complete = toCompleteRecord(folded.get(runId));
		if (complete) {
			records.push(complete);
		} else {
			malformedLines++;
		}
	}

	return { records, malformedLines };
}

/** Apply an update to a known run. Returns the base untouched when the update is for another run. */
export function mergeAgentRunUpdate(base: AgentRunRecord, update: AgentRunUpdate): AgentRunRecord {
	if (base.runId !== update.runId) {
		return base;
	}
	return { ...base, ...update };
}

/**
 * Runs left behind by a window that is gone: non-terminal, stamped with a foreign epoch, and
 * silent for longer than `staleAfterMs`.
 *
 * The liveness check is not optional. Two windows may hold the same workspace — that is a
 * supported setup here — so marking every foreign run as abandoned would slander a window that
 * is working fine. Only silence proves absence.
 *
 * Abandoned runs are marked, never deleted: hiding one is exactly how a stale runtime keeps
 * burning tokens unnoticed.
 */
export function markOrphanedRuns(
	records: readonly AgentRunRecord[],
	currentEpoch: string,
	now: number,
	staleAfterMs: number,
): { readonly records: readonly AgentRunRecord[]; readonly orphanedIds: readonly string[] } {
	const orphanedIds: string[] = [];
	const next = records.map(record => {
		if (record.epoch === currentEpoch || isTerminalRunStatus(record.status)) {
			return record;
		}
		const lastSign = record.lastSeenAt ?? record.startedAt;
		if (now - lastSign < staleAfterMs) {
			return record;
		}
		orphanedIds.push(record.runId);
		return { ...record, status: 'orphaned' as const, endedAt: record.endedAt ?? now };
	});
	return { records: next, orphanedIds };
}

/**
 * Trim the log: terminal runs older than the retention window go first, then the oldest terminal
 * runs until the count fits. Live runs are never dropped — losing the record of something still
 * running would defeat the point.
 */
export function pruneAgentRuns(records: readonly AgentRunRecord[], options: AgentRunPruneOptions): readonly AgentRunRecord[] {
	const retentionMs = Math.max(0, options.retentionDays) * 24 * 60 * 60 * 1000;
	const cutoff = retentionMs > 0 ? options.now - retentionMs : undefined;

	const kept = records.filter(record => {
		if (!isTerminalRunStatus(record.status)) {
			return true;
		}
		if (cutoff === undefined) {
			return true;
		}
		return (record.endedAt ?? record.startedAt) >= cutoff;
	});

	const maxRecords = Math.max(0, options.maxRecords);
	if (maxRecords === 0 || kept.length <= maxRecords) {
		return kept;
	}

	const live = kept.filter(record => !isTerminalRunStatus(record.status));
	const terminal = kept.filter(record => isTerminalRunStatus(record.status));
	const roomForTerminal = Math.max(0, maxRecords - live.length);
	if (roomForTerminal === 0) {
		return live;
	}

	// Oldest terminal runs go first; `kept` order is file order, so the tail is the newest.
	const survivingTerminal = new Set(terminal.slice(-roomForTerminal).map(record => record.runId));
	return kept.filter(record => !isTerminalRunStatus(record.status) || survivingTerminal.has(record.runId));
}

export function summariseAgentRuns(records: readonly AgentRunRecord[]): AgentRunSummary {
	let live = 0;
	let orphaned = 0;
	let failed = 0;
	let limited = 0;
	let tokensTotal = 0;

	for (const record of records) {
		if (!isTerminalRunStatus(record.status)) {
			live++;
		}
		if (record.status === 'orphaned') {
			orphaned++;
		}
		if (record.status === 'failed') {
			failed++;
		}
		if (record.stopCode && LIMIT_STOP_CODES.has(record.stopCode)) {
			limited++;
		}
		tokensTotal += record.tokensUsed ?? 0;
	}

	return { total: records.length, live, orphaned, failed, limited, tokensTotal };
}

// ── Decoding ──────────────────────────────────────────────────────────────────
// Log lines come off disk and may have been hand-edited, so every field is read through a
// narrow getter instead of being trusted from the parsed JSON.

function decodeUpdate(line: string): AgentRunUpdate | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const raw = parsed as Record<string, unknown>;
	const runId = readString(raw.runId);
	if (!runId) {
		return undefined;
	}

	const update: Record<string, unknown> = { runId };
	assignIfDefined(update, 'epoch', readString(raw.epoch));
	assignIfDefined(update, 'fence', isAgentRunFence(raw.fence) ? raw.fence : undefined);
	assignIfDefined(update, 'role', readString(raw.role));
	assignIfDefined(update, 'goal', readString(raw.goal));
	assignIfDefined(update, 'parentThreadId', readString(raw.parentThreadId));
	assignIfDefined(update, 'status', readStatus(raw.status));
	assignIfDefined(update, 'startedAt', readNumber(raw.startedAt));
	assignIfDefined(update, 'lastSeenAt', readNumber(raw.lastSeenAt));
	assignIfDefined(update, 'endedAt', readNumber(raw.endedAt));
	assignIfDefined(update, 'tokensUsed', readNumber(raw.tokensUsed));
	assignIfDefined(update, 'cachedTokens', readNumber(raw.cachedTokens));
	assignIfDefined(update, 'tokenQuota', readNumber(raw.tokenQuota));
	assignIfDefined(update, 'stepsDone', readNumber(raw.stepsDone));
	assignIfDefined(update, 'maxSteps', readNumber(raw.maxSteps));
	assignIfDefined(update, 'artifacts', readStringArray(raw.artifacts));
	assignIfDefined(update, 'stopCode', readString(raw.stopCode));
	assignIfDefined(update, 'provider', readString(raw.provider));
	assignIfDefined(update, 'model', readString(raw.model));
	assignIfDefined(update, 'summary', readString(raw.summary));
	assignIfDefined(update, 'fingerprint', readString(raw.fingerprint));
	assignIfDefined(update, 'resumeReason', readString(raw.resumeReason));
	assignIfDefined(update, 'replayOfRunId', readString(raw.replayOfRunId));
	assignIfDefined(update, 'failureReason', readString(raw.failureReason));

	return update as AgentRunUpdate;
}

function toCompleteRecord(partial: Partial<AgentRunRecord> | undefined): AgentRunRecord | undefined {
	if (!partial) {
		return undefined;
	}
	const { runId, epoch, fence, role, goal, parentThreadId, status, startedAt } = partial;
	if (!runId || !epoch || !fence || !role || goal === undefined || !parentThreadId || !status || startedAt === undefined) {
		return undefined;
	}
	return { ...partial, runId, epoch, fence, role, goal, parentThreadId, status, startedAt };
}

function assignIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
	if (value !== undefined) {
		target[key] = value;
	}
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.filter((item): item is string => typeof item === 'string');
}

function readStatus(value: unknown): AgentRunStatus | undefined {
	const candidate = readString(value);
	return candidate && (RUN_STATUSES as readonly string[]).includes(candidate) ? candidate as AgentRunStatus : undefined;
}
