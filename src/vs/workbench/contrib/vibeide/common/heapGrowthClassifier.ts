/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Memory profiler — heap growth classifier (pure helper).
 *
 * L.4 line 1039 — `vibeide.dev.memorySnapshot` palette command (dev only) takes a
 * baseline heap snapshot, then compares against a later snapshot to surface leaks
 * in long sessions. The classification is the same regardless of which API
 * captures the snapshot (`process.memoryUsage()` in Node, Electron heap snapshot,
 * Chrome DevTools v8 dump) — only the underlying byte counts change.
 *
 * Adoption order:
 *   1. Palette command `vibeide.dev.memorySnapshot` registered via Action2 in dev
 *      mode only (`product.isDev` guard).
 *   2. First invocation captures `baseline` and stores in extension storage.
 *   3. Second invocation captures `current`, calls `classifyHeapGrowth(baseline,
 *      current)`, and routes the discriminated-union result into:
 *        - 'inconclusive'      → notification "wait at least 60s and re-snapshot"
 *        - 'flat'              → information "heap stable"
 *        - 'shrinking'         → information "heap shrunk by X% (GC)"
 *        - 'growing-normal'    → information "heap grew by X%"
 *        - 'leak-suspicious'   → warning "heap grew by X%; possible leak"
 *      All paths invoke `renderHeapGrowthMarkdown` for the output channel body.
 */

export interface HeapSnapshot {
	readonly capturedAtMs: number;
	readonly heapUsedBytes: number;
	readonly heapTotalBytes: number;
	readonly externalBytes?: number;
	readonly arrayBuffersBytes?: number;
	readonly label?: string;
}

export type HeapGrowthClassification =
	| 'inconclusive'
	| 'flat'
	| 'shrinking'
	| 'growing-normal'
	| 'leak-suspicious';

export interface HeapGrowthDiff {
	readonly classification: HeapGrowthClassification;
	readonly elapsedMs: number;
	readonly deltaUsedBytes: number;
	readonly deltaUsedPct: number;       // signed, rounded to 1 decimal
	readonly deltaTotalBytes: number;
	readonly baselineLabel?: string;
	readonly currentLabel?: string;
	/** Human-readable reasoning for the chosen classification. */
	readonly reason: string;
}

export interface ClassifyOptions {
	/** Below this elapsed window the result is 'inconclusive'. Default 60_000 (1 min). */
	readonly minElapsedMs?: number;
	/** Absolute change threshold for "flat". Default 1_048_576 (1 MiB). */
	readonly flatBytesThreshold?: number;
	/** Percent threshold for "flat". Default 0.01 (1%). */
	readonly flatPctThreshold?: number;
	/** Percent above which growth becomes "leak-suspicious". Default 0.20 (20%). */
	readonly leakPctThreshold?: number;
	/** Absolute byte threshold paired with leakPctThreshold. Default 52_428_800 (50 MiB). */
	readonly leakBytesThreshold?: number;
}

const DEFAULTS: Required<ClassifyOptions> = {
	minElapsedMs: 60_000,
	flatBytesThreshold: 1_048_576,
	flatPctThreshold: 0.01,
	leakPctThreshold: 0.20,
	leakBytesThreshold: 52_428_800,
};

/**
 * Pure: classifies the relationship between baseline and current snapshots.
 *
 * Decision tree (top-down):
 *   1. elapsed < minElapsedMs                                        → 'inconclusive'
 *   2. |Δbytes| < flatBytesThreshold AND |Δpct| < flatPctThreshold   → 'flat'
 *   3. Δbytes < 0 AND |Δpct| > flatPctThreshold                      → 'shrinking'
 *   4. Δpct > leakPctThreshold AND Δbytes > leakBytesThreshold       → 'leak-suspicious'
 *   5. otherwise                                                     → 'growing-normal'
 *
 * Both pct and bytes thresholds must be exceeded for 'leak-suspicious' so that:
 *   - a tiny base of 10 MB doubling (large %) doesn't fire on a 10 MB process
 *   - a multi-GB process with a 51 MB leak (small %) still fires
 *
 * Pct uses heapUsedBytes (the smaller, more variable number) — heapTotalBytes
 * jitters with V8 generation cycles.
 */
export function classifyHeapGrowth(
	baseline: HeapSnapshot,
	current: HeapSnapshot,
	options: ClassifyOptions = {},
): HeapGrowthDiff {
	const opts = { ...DEFAULTS, ...options };
	const elapsedMs = current.capturedAtMs - baseline.capturedAtMs;
	const deltaUsedBytes = current.heapUsedBytes - baseline.heapUsedBytes;
	const deltaTotalBytes = current.heapTotalBytes - baseline.heapTotalBytes;
	const deltaUsedPct = baseline.heapUsedBytes > 0
		? roundPct(deltaUsedBytes / baseline.heapUsedBytes)
		: 0;
	const base = {
		elapsedMs,
		deltaUsedBytes,
		deltaUsedPct,
		deltaTotalBytes,
		baselineLabel: baseline.label,
		currentLabel: current.label,
	};

	if (elapsedMs < opts.minElapsedMs) {
		return { ...base, classification: 'inconclusive', reason: `elapsed ${elapsedMs}ms < ${opts.minElapsedMs}ms minimum` };
	}
	const absBytes = Math.abs(deltaUsedBytes);
	const absPct = Math.abs(deltaUsedPct);
	if (absBytes < opts.flatBytesThreshold && absPct < opts.flatPctThreshold) {
		return { ...base, classification: 'flat', reason: `Δ ${absBytes}B / ${formatPct(absPct)} below flat thresholds` };
	}
	if (deltaUsedBytes < 0 && absPct >= opts.flatPctThreshold) {
		return { ...base, classification: 'shrinking', reason: `heap shrunk by ${formatPct(absPct)} (likely GC pass)` };
	}
	if (deltaUsedPct > opts.leakPctThreshold && deltaUsedBytes > opts.leakBytesThreshold) {
		return {
			...base,
			classification: 'leak-suspicious',
			reason: `growth ${formatPct(deltaUsedPct)} (≥ ${formatPct(opts.leakPctThreshold)}) AND ${deltaUsedBytes}B (≥ ${opts.leakBytesThreshold}B)`,
		};
	}
	return { ...base, classification: 'growing-normal', reason: `growth ${formatPct(deltaUsedPct)} within normal band` };
}

/**
 * Pure: validates a snapshot shape — returns the typed value or null on
 * malformation. Use to parse persisted baseline blobs (extension storage) before
 * calling `classifyHeapGrowth`.
 */
export function decodeHeapSnapshot(raw: unknown): HeapSnapshot | null {
	if (!raw || typeof raw !== 'object') { return null; }
	const r = raw as Record<string, unknown>;
	const capturedAtMs = num(r.capturedAtMs);
	const heapUsedBytes = num(r.heapUsedBytes);
	const heapTotalBytes = num(r.heapTotalBytes);
	if (capturedAtMs === null || heapUsedBytes === null || heapTotalBytes === null) { return null; }
	if (heapUsedBytes < 0 || heapTotalBytes < 0) { return null; }
	const externalBytes = num(r.externalBytes) ?? undefined;
	const arrayBuffersBytes = num(r.arrayBuffersBytes) ?? undefined;
	const label = typeof r.label === 'string' && r.label.length > 0 ? r.label : undefined;
	return {
		capturedAtMs, heapUsedBytes, heapTotalBytes,
		...(externalBytes !== undefined ? { externalBytes } : {}),
		...(arrayBuffersBytes !== undefined ? { arrayBuffersBytes } : {}),
		...(label ? { label } : {}),
	};
}

/**
 * Pure: renders a markdown report suitable for an Output channel or vibe doctor
 * --memory section. Includes classification, deltas, and (when present) the
 * baseline/current labels.
 */
export function renderHeapGrowthMarkdown(diff: HeapGrowthDiff): string {
	const tag = `**${diff.classification}**`;
	const labels = diff.baselineLabel || diff.currentLabel
		? `\n\n_baseline: ${diff.baselineLabel ?? '(unlabelled)'} → current: ${diff.currentLabel ?? '(unlabelled)'}_`
		: '';
	return [
		`## VibeIDE — heap growth report`,
		``,
		`Classification: ${tag}`,
		``,
		`- elapsed: ${formatDurationMs(diff.elapsedMs)}`,
		`- Δ heapUsed: ${signed(diff.deltaUsedBytes)}B (${formatPct(diff.deltaUsedPct)})`,
		`- Δ heapTotal: ${signed(diff.deltaTotalBytes)}B`,
		``,
		`_${diff.reason}_${labels}`,
	].join('\n');
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function roundPct(p: number): number {
	if (!Number.isFinite(p)) { return 0; }
	return Math.round(p * 1000) / 1000;
}

function formatPct(p: number): string {
	const sign = p > 0 ? '+' : p < 0 ? '' : '';
	return `${sign}${(p * 100).toFixed(1)}%`;
}

function signed(v: number): string {
	return v >= 0 ? `+${v}` : `${v}`;
}

function formatDurationMs(ms: number): string {
	if (ms < 60_000) { return `${Math.round(ms / 1_000)}s`; }
	if (ms < 3_600_000) { return `${Math.round(ms / 60_000)}m`; }
	return `${Math.round(ms / 3_600_000)}h`;
}
