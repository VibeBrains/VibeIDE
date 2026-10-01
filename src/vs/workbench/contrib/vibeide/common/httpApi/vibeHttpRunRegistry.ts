/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isTerminalHttpRunStatus, VibeHttpRunReport, VibeHttpRunSnapshot, VibeHttpRunStatus } from './vibeHttpApiTypes.js';

/** A finished run stays readable for an hour: long enough for a CI job to poll it, short enough not to pile up */
export const RUN_TTL_AFTER_FINISH_MS = 60 * 60_000;

/** A run that never reported an end is dropped after a day — by then nobody is polling it */
export const RUN_TTL_UNFINISHED_MS = 24 * 60 * 60_000;

/** Ceiling on remembered sessions; past it the least recently updated one goes */
export const MAX_TRACKED_RUNS = 500;

interface RunEntry {
	readonly requestId: string;
	readonly instanceId: string;
	readonly sessionId: string;
	readonly status: VibeHttpRunStatus;
	readonly answer?: string;
	readonly answerTruncated?: boolean;
	readonly error?: string;
	readonly startedAtMs: number;
	readonly updatedAtMs: number;
	readonly finishedAtMs?: number;
}

/**
 * Where the latest HTTP-started run of each session stands, for `GET /run/<sessionId>`
 *
 * Lives in the main process so a window reload does not wipe it; it is memory only, so an IDE restart does
 * Keyed by session: a session continued by a new `POST /run` shows the new run, told apart by its request id
 * A terminal status never reverts — a late «running» from a slow channel must not resurrect a finished run
 * The clock is injected so expiry is testable without waiting an hour
 */
export class VibeHttpRunRegistry {

	private readonly _entries = new Map<string, RunEntry>();

	constructor(private readonly _now: () => number) { }

	report(report: VibeHttpRunReport): void {
		const now = this._now();
		this._prune(now);
		const existing = this._entries.get(report.sessionId);
		const sameRun = existing?.requestId === report.requestId;
		if (existing && sameRun && isTerminalHttpRunStatus(existing.status)) {
			return;
		}
		if (!existing && this._entries.size >= MAX_TRACKED_RUNS) {
			this._evictOldest();
		}
		const terminal = isTerminalHttpRunStatus(report.status);
		this._entries.set(report.sessionId, {
			requestId: report.requestId,
			instanceId: report.instanceId,
			sessionId: report.sessionId,
			status: report.status,
			...(report.answer !== undefined ? { answer: report.answer } : {}),
			...(report.answerTruncated ? { answerTruncated: true } : {}),
			...(report.error !== undefined ? { error: report.error } : {}),
			startedAtMs: existing && sameRun ? existing.startedAtMs : now,
			updatedAtMs: now,
			...(terminal ? { finishedAtMs: now } : {}),
		});
	}

	get(sessionId: string): VibeHttpRunSnapshot | undefined {
		this._prune(this._now());
		const entry = this._entries.get(sessionId);
		return entry ? toSnapshot(entry) : undefined;
	}

	/**
	 * End every unfinished run executed by a window instance that is gone
	 * Its renderer took the agent loop with it, so «running» would be a promise nobody can keep
	 */
	failRunsOf(instanceId: string, error: string): void {
		const now = this._now();
		for (const [sessionId, entry] of this._entries) {
			if (entry.instanceId === instanceId && !isTerminalHttpRunStatus(entry.status)) {
				this._entries.set(sessionId, { ...entry, status: 'failed', error, updatedAtMs: now, finishedAtMs: now });
			}
		}
	}

	private _prune(now: number): void {
		for (const [sessionId, entry] of this._entries) {
			const expired = entry.finishedAtMs !== undefined
				? now - entry.finishedAtMs > RUN_TTL_AFTER_FINISH_MS
				: now - entry.updatedAtMs > RUN_TTL_UNFINISHED_MS;
			if (expired) {
				this._entries.delete(sessionId);
			}
		}
	}

	private _evictOldest(): void {
		let oldest: RunEntry | undefined;
		for (const entry of this._entries.values()) {
			if (!oldest || entry.updatedAtMs < oldest.updatedAtMs) {
				oldest = entry;
			}
		}
		if (oldest) {
			this._entries.delete(oldest.sessionId);
		}
	}
}

function toSnapshot(entry: RunEntry): VibeHttpRunSnapshot {
	return {
		sessionId: entry.sessionId,
		status: entry.status,
		...(entry.answer !== undefined ? { answer: entry.answer } : {}),
		...(entry.answerTruncated ? { answerTruncated: true } : {}),
		...(entry.error !== undefined ? { error: entry.error } : {}),
		startedAt: new Date(entry.startedAtMs).toISOString(),
		updatedAt: new Date(entry.updatedAtMs).toISOString(),
		...(entry.finishedAtMs !== undefined ? { finishedAt: new Date(entry.finishedAtMs).toISOString() } : {}),
	};
}
