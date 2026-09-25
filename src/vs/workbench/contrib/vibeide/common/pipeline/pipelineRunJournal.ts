/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The journal of pipeline runs: which steps of a run finished, so an interrupted run continues from the unfinished ones.
 *
 * VibeIDEA keeps the numbers of the finished steps and asks «continue from step N / restart» (`PipelineResume.kt`); here the
 * finished steps' outcomes are kept too, so the steps after the resume point get what the earlier ones reported — their
 * summaries and artifacts — instead of starting blind. One JSON line per write, the last line of a run wins.
 * Pure: the pipeline service reads and writes the file (`.vibe/local/pipeline-runs.jsonl`).
 */

import { PipelineStepOutcome, VibePipeline } from './vibePipelineFile.js';

export type PipelineRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface PipelineRunRecord {
	readonly runId: string;
	readonly pipelineId: string;
	/** The pipeline's steps as they were at the start (`pipelineShapeOf`): a run of a changed pipeline is not continued */
	readonly shape: string;
	readonly totalSteps: number;
	readonly status: PipelineRunStatus;
	/** The window that runs it; with `heartbeatAt` it tells a run still under way from one whose window closed */
	readonly epoch: string;
	readonly startedAt: number;
	readonly heartbeatAt: number;
	readonly finishedAt?: number;
	/** What the steps that ran reported, in file order — the finished ones are what a resumed run is given */
	readonly outcomes: readonly PipelineStepOutcome[];
}

/** An interrupted run a person may continue */
export interface ResumableRun {
	readonly record: PipelineRunRecord;
	/** Indices (from 0) of the steps that finished successfully */
	readonly done: ReadonlySet<number>;
	/** The first step to run, from 0 */
	readonly fromStep: number;
	/** Why it stopped: `stopped` — «Стоп», `failed` — a step failed, `orphaned` — its window closed mid-run */
	readonly reason: 'stopped' | 'failed' | 'orphaned';
}

/** Roles, waves and order of the steps — what the finished steps' numbers are only meaningful against */
export function pipelineShapeOf(pipeline: Pick<VibePipeline, 'steps'>): string {
	return pipeline.steps.map(step => `${step.role}${step.wave ? `@${step.wave}` : ''}`).join('>');
}

/** One journal line */
export function serializePipelineRun(record: PipelineRunRecord): string {
	return `${JSON.stringify(record)}\n`;
}

function isRecord(value: unknown): value is PipelineRunRecord {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const r = value as Record<string, unknown>;
	return typeof r.runId === 'string' && typeof r.pipelineId === 'string' && typeof r.shape === 'string'
		&& typeof r.totalSteps === 'number' && typeof r.epoch === 'string' && typeof r.startedAt === 'number'
		&& typeof r.heartbeatAt === 'number' && Array.isArray(r.outcomes)
		&& (r.status === 'running' || r.status === 'completed' || r.status === 'failed' || r.status === 'stopped');
}

/** The runs in the journal, the last line of each run winning; a broken line is skipped, not fatal */
export function parsePipelineRunJournal(text: string): PipelineRunRecord[] {
	const byId = new Map<string, PipelineRunRecord>();
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) {
				byId.set(parsed.runId, parsed);
			}
		} catch {
			// A torn line from a crash mid-write costs that line, not the journal
		}
	}
	return [...byId.values()];
}

/**
 * The run of `pipelineId` that may be continued: its latest run, if that one stopped short — «Стоп», a failed step, or
 * a window that closed while it ran (a run of another window gone quiet for longer than `staleAfterMs`)
 * Only when the pipeline still has the same steps and at least one of them finished: nothing to skip is a restart
 */
export function resumableRunOf(records: readonly PipelineRunRecord[], pipeline: Pick<VibePipeline, 'id' | 'steps'>, currentEpoch: string, now: number, staleAfterMs: number): ResumableRun | undefined {
	const latest = records.filter(r => r.pipelineId === pipeline.id).sort((a, b) => b.startedAt - a.startedAt)[0];
	if (!latest || latest.shape !== pipelineShapeOf(pipeline) || latest.totalSteps !== pipeline.steps.length) {
		return undefined;
	}
	const orphaned = latest.status === 'running' && latest.epoch !== currentEpoch && now - latest.heartbeatAt > staleAfterMs;
	if (latest.status !== 'stopped' && latest.status !== 'failed' && !orphaned) {
		return undefined;
	}
	const done = new Set(latest.outcomes.filter(o => o.status === 'success').map(o => o.step - 1));
	if (done.size === 0 || done.size >= latest.totalSteps) {
		return undefined;
	}
	let fromStep = 0;
	while (done.has(fromStep)) {
		fromStep++;
	}
	return { record: latest, done, fromStep, reason: orphaned ? 'orphaned' : latest.status === 'stopped' ? 'stopped' : 'failed' };
}

/**
 * The journal trimmed to what is worth keeping: the newest `maxRecords` runs within `retentionDays`
 * A run still under way is never dropped — its window writes to it
 */
export function compactPipelineRunJournal(records: readonly PipelineRunRecord[], now: number, maxRecords: number, retentionDays: number): PipelineRunRecord[] {
	const oldest = now - retentionDays * 24 * 60 * 60 * 1000;
	const sorted = [...records].sort((a, b) => b.startedAt - a.startedAt);
	return sorted.filter((r, i) => r.status === 'running' || (i < maxRecords && r.startedAt >= oldest)).reverse();
}
