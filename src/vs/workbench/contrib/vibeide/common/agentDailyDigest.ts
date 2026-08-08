/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AgentRunRecord, isLimitStopCode, isTerminalRunStatus } from './agentRunLedger.js';

/**
 * "What happened while you were away" — the daily digest of agent runs.
 *
 * Ordered by what can still go wrong, not by time: a failed run is the reason to open the laptop,
 * a successful one is not. Successes are therefore collapsed into a count while every failure is
 * named — a digest that lists twenty green runs and buries the red one has told the reader
 * nothing they needed.
 *
 * Pure: the same text is shown in the IDE and sent to Telegram, so it must not depend on either.
 */

/** Runs to name individually before switching to counts. */
const MAX_NAMED_RUNS = 5;

/** How much of a goal survives in a one-line entry. */
const GOAL_LIMIT = 80;

export interface AgentDailyDigest {
	readonly periodFromMs: number;
	readonly periodToMs: number;
	readonly total: number;
	readonly failed: readonly AgentRunRecord[];
	readonly limited: readonly AgentRunRecord[];
	readonly succeeded: number;
	readonly stillRunning: number;
	readonly tokensTotal: number;
	/** Files touched by the runs in the period, deduplicated. */
	readonly artifacts: readonly string[];
}

/** Runs that ended (or started) inside the window, folded into a digest. */
export function buildAgentDailyDigest(records: readonly AgentRunRecord[], period: { readonly fromMs: number; readonly toMs: number }): AgentDailyDigest {
	const inPeriod = records.filter(r => {
		// A run counts if any part of it falls in the window: one started yesterday and finished
		// this morning is exactly what the reader wants to hear about.
		const started = r.startedAt;
		const ended = r.endedAt ?? r.lastSeenAt ?? r.startedAt;
		return ended >= period.fromMs && started <= period.toMs;
	});

	const failed = inPeriod.filter(r => r.status === 'failed' || r.status === 'orphaned');
	// Only ceiling codes count as "limited": the ledger distinguishes them from ordinary stop
	// reasons, and calling every stopped run limited would inflate the section people read first.
	const limited = inPeriod.filter(r => isLimitStopCode(r.stopCode) && r.status !== 'failed' && r.status !== 'orphaned');
	const stillRunning = inPeriod.filter(r => !isTerminalRunStatus(r.status)).length;
	const succeeded = inPeriod.length - failed.length - limited.length - stillRunning;

	const artifacts = new Set<string>();
	for (const record of inPeriod) {
		for (const artifact of record.artifacts ?? []) {
			artifacts.add(artifact);
		}
	}

	return {
		periodFromMs: period.fromMs,
		periodToMs: period.toMs,
		total: inPeriod.length,
		failed,
		limited,
		succeeded: Math.max(0, succeeded),
		stillRunning,
		tokensTotal: inPeriod.reduce((sum, r) => sum + (r.tokensUsed ?? 0), 0),
		artifacts: [...artifacts],
	};
}

function shorten(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function describeRun(record: AgentRunRecord): string {
	const reason = record.failureReason ? `: ${shorten(record.failureReason, 60)}` : record.stopCode ? ` (${record.stopCode})` : '';
	return `• ${record.role} — ${shorten(record.goal, GOAL_LIMIT)}${reason}`;
}

/**
 * The digest as markdown, ready for the chat and for the IDE.
 *
 * Returns `undefined` when nothing happened: an empty daily report trains the reader to ignore
 * the channel it arrives in.
 */
export function formatAgentDailyDigest(digest: AgentDailyDigest): string | undefined {
	if (digest.total === 0) {
		return undefined;
	}
	const lines: string[] = [];
	const problems = digest.failed.length + digest.limited.length;
	lines.push(problems > 0
		? `⚠️ Сводка за сутки: ${digest.total} прогонов, из них требуют внимания ${problems}.`
		: `✅ Сводка за сутки: ${digest.total} прогонов, всё прошло без срывов.`);

	if (digest.failed.length) {
		lines.push('', `**Упали (${digest.failed.length}):**`, ...digest.failed.slice(0, MAX_NAMED_RUNS).map(describeRun));
		if (digest.failed.length > MAX_NAMED_RUNS) {
			lines.push(`…и ещё ${digest.failed.length - MAX_NAMED_RUNS}`);
		}
	}
	if (digest.limited.length) {
		lines.push('', `**Остановлены лимитом (${digest.limited.length}):**`, ...digest.limited.slice(0, MAX_NAMED_RUNS).map(describeRun));
		if (digest.limited.length > MAX_NAMED_RUNS) {
			lines.push(`…и ещё ${digest.limited.length - MAX_NAMED_RUNS}`);
		}
	}

	const tail: string[] = [];
	if (digest.succeeded) { tail.push(`успешных ${digest.succeeded}`); }
	if (digest.stillRunning) { tail.push(`ещё работают ${digest.stillRunning}`); }
	if (digest.tokensTotal) { tail.push(`токенов ${digest.tokensTotal.toLocaleString('ru-RU')}`); }
	if (digest.artifacts.length) { tail.push(`затронуто файлов ${digest.artifacts.length}`); }
	if (tail.length) {
		lines.push('', tail.join(', ') + '.');
	}
	return lines.join('\n');
}
