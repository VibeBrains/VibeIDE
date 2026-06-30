/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Idle Watchdog — diagnostic sampler for VibeIDE processes.
 *
 * Writes one line per sample to `${userDataPath}/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`.
 * Used to diagnose slow leaks and overnight OOMs that DevTools can't catch
 * (no one watches `console.warn` at 4 AM).
 *
 * **Coverage** (post-W.0/W.1/W.2 refactor): main is single writer to disk; renderer
 * and extension host push samples via IPC channel `vibeide-channel-idleWatchdog`.
 * `proc` field discriminates origin; legacy lines (no `proc`) are treated as `main`.
 *
 * **Configuration** (`vibeide.diagnostics.idleWatchdog.*`):
 *   - `enabled`              boolean, default true
 *   - `intervalMinutes`      1..60, default 5
 *   - `retentionDays`        1..90, default 3
 *   - `includeProcessReport` boolean, default false (W.13)
 *   - `heapSnapshotOnHighRss` boolean, default false (W.4)
 *   - `heapSnapshotThresholdMB` 100..16000, default 2000
 *   - `snapshotCooldownMinutes` 5..1440, default 30
 *   - `growthAlertMBPerMin`  1..200, default 5 (W.5)
 *   - `heapSnapshotOnRapidGrowth` boolean, default false (O.12) — snapshot on per-tick RSS jump
 *   - `snapshotGrowthDeltaMB` 50..8000, default 500 (O.12) — per-tick RSS jump (MB) that triggers it
 *
 * Settings hot-reload (W.8): `fs.watch` on `User/settings.json` re-reads on change.
 *
 * @see docs/knowledge/runtime-quirks/idle-memory.md
 * @see docs/roadmap.md (section W)
 */

import * as path from '../../../../base/common/path.js';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as zlib from 'zlib';
import { PerformanceObserver } from 'perf_hooks';

/** Minimal view of the `v8` builtin used here (heap-snapshot writer + heap-limit query). */
interface V8HeapSnapshotModule {
	writeHeapSnapshot(filename?: string): string;
	getHeapStatistics(): { heap_size_limit: number };
}

// `v8` is not on the allowed static-import list for this layer, and `writeHeapSnapshot`
// is called from synchronous code paths (IPC-driven snapshot triggers) where switching
// to `await import('v8')` would change the public contract. Resolve it once via a
// synchronous CJS require, keeping behavior identical.
const v8: V8HeapSnapshotModule = createRequire(import.meta.url)('v8');
import { app, webContents, powerMonitor } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { parse as parseJsonc } from '../../../../base/common/jsonc.js';

// `setTimeout` / `setInterval` in Electron-main return native NodeJS.Timeout, but
// VS Code re-types `setTimeout` as returning `TimeoutHandle` (no `.unref`). The
// runtime handle DOES support `.unref()`. We use a feature-detection cast (same
// pattern as `electron-main/modelQuirks/modelQuirksService.ts:171,176`).
type TimerHandle = ReturnType<typeof setTimeout>;
function unrefTimer(handle: TimerHandle | null): void {
	const h = handle as unknown as { unref?: () => void };
	if (typeof h?.unref === 'function') { h.unref(); }
}
import type {
	WatchdogCrashEntry,
	WatchdogLine,
	WatchdogPreOomAlert,
	WatchdogProc,
	WatchdogProcessReportSubset,
	WatchdogSampleBase,
	WatchdogSnapshotEntry,
} from '../common/vibeIdleWatchdogTypes.js';
import { computeSamplingIntervalMs } from '../common/vibeIdleWatchdogSampling.js';
import { getNormalizeCounters } from '../common/xmlToolNormalize.js';

const LOGS_SUBDIR = path.join('logs', 'vibe-idle-watchdog');
const SNAPSHOTS_SUBDIR = path.join(LOGS_SUBDIR, 'snapshots');

interface WatchdogConfig {
	readonly enabled: boolean;
	readonly intervalMinutes: number;
	readonly retentionDays: number;
	readonly includeProcessReport: boolean;
	readonly heapSnapshotOnHighRss: boolean;
	readonly heapSnapshotThresholdMB: number;
	readonly snapshotCooldownMinutes: number;
	readonly growthAlertMBPerMin: number;
	/** Require the growth slope to stay above `growthAlertMBPerMin` for this many CONSECUTIVE
	 * evaluations before alerting — filters transient GC-sawtooth rising edges that a single
	 * 12-sample window catches. 1 = legacy one-shot behavior. */
	readonly sustainedAlertSamples: number;
	/** Capture a heap snapshot when a single-tick RSS jump exceeds `snapshotGrowthDeltaMB` (O.12) —
	 * complements `heapSnapshotOnHighRss`, which only fires on absolute RSS. A balloon that crashes
	 * before reaching the absolute threshold (renderer OOM, crash-report 2026-05-25) leaves no snapshot
	 * under the threshold rule alone. Off by default — heap snapshots pause the process and are large. */
	readonly heapSnapshotOnRapidGrowth: boolean;
	/** Per-tick RSS jump (MB, vs the previous sample for the SAME process) that triggers a growth snapshot. */
	readonly snapshotGrowthDeltaMB: number;
	readonly maxSnapshotsRetained: number;
	readonly includeChildProcessTypes: readonly string[];
	/** Total disk budget for `logs/vibe-idle-watchdog/` (`.jsonl` + snapshots). W.26. */
	readonly maxLogsTotalMB: number;
	/** Pre-OOM threshold for `heapUsed / heapLimit` ratio (W.42). */
	readonly preOomHeapRatio: number;
	/** Allow opt-in graceful auto-restart on pre-OOM (W.46). */
	readonly autoRestartOnPreOom: boolean;
	/** Gzip-compress `.jsonl` files older than today (W.30). */
	readonly compressOldJsonl: boolean;
	/** Adaptive: when idleSec > threshold, reduce sampling rate (W.50). */
	readonly adaptiveSampling: boolean;
	/** Use statistical (3-sigma) slope detection instead of fixed threshold (W.33). */
	readonly statisticalOutlier: boolean;
	/**
	 * Absolute private-commit (privateBytes) in MB that trips a pre-OOM alert for a
	 * process. Catches commit-charge balloons invisible to the V8-heap-ratio rule
	 * (renderer OOM 2026-05-30: heap 0.08 of limit, but ~13 GB committed). 0 disables.
	 */
	readonly commitAlertMB: number;
	/**
	 * 1630 — temporarily shrink the sampling interval to `burstSamplingSeconds` for
	 * `burstDurationTicks` ticks once a slope / pre-OOM alert fires, so a sub-60s spike
	 * is captured instead of slipping between two `intervalMinutes` samples.
	 */
	readonly burstSamplingEnabled: boolean;
	readonly burstSamplingSeconds: number;
	readonly burstDurationTicks: number;
	/** B: auto-capture a renderer's heap snapshot when its private commit crosses `commitAlertMB`.
	 *  Off by default — a snapshot of a multi-GB renderer near OOM is a heavy, slow operation. */
	readonly snapshotRenderersOnCommitAlert: boolean;
	/** W.55: auto-capture a renderer's heap snapshot the moment its commit-SLOPE alert fires
	 *  (balloon still forming, ~2 GB) instead of waiting for the absolute `commitAlertMB`.
	 *  Catches the culprit objects while the spike is in progress (crash-report 2026-05-31:
	 *  commit ballooned to ~2 GB under agent load but never reached the 3.5 GB threshold, so no
	 *  renderer snapshot was taken). Off by default — heavy operation; shares the once-per-pid guard. */
	readonly snapshotRenderersOnCommitSlope: boolean;
}

const DEFAULT_CHILD_PROCESS_TYPES: readonly string[] = ['Utility', 'GPU'];

const DEFAULTS: WatchdogConfig = {
	enabled: true,
	intervalMinutes: 5,
	retentionDays: 3,
	includeProcessReport: false,
	heapSnapshotOnHighRss: false,
	heapSnapshotThresholdMB: 2000,
	snapshotCooldownMinutes: 30,
	growthAlertMBPerMin: 5,
	sustainedAlertSamples: 3,
	heapSnapshotOnRapidGrowth: false,
	snapshotGrowthDeltaMB: 500,
	maxSnapshotsRetained: 3,
	includeChildProcessTypes: DEFAULT_CHILD_PROCESS_TYPES,
	maxLogsTotalMB: 500,
	preOomHeapRatio: 0.85,
	autoRestartOnPreOom: false,
	compressOldJsonl: true,
	adaptiveSampling: false,
	statisticalOutlier: false,
	commitAlertMB: 3500, // D.4a: lowered from 4000 — real renderer OOM (2026-05-30) was ~4.5 GB commit; earlier lead time before the fatal abort.
	burstSamplingEnabled: true,
	burstSamplingSeconds: 15,
	burstDurationTicks: 12,
	snapshotRenderersOnCommitAlert: false,
	snapshotRenderersOnCommitSlope: false,
};

const PERSISTED_STATE_FILE = 'state.json';

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) { return fallback; }
	return Math.max(min, Math.min(max, Math.round(n)));
}

function clampBool(v: unknown, fallback: boolean): boolean {
	return typeof v === 'boolean' ? v : fallback;
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) { return fallback; }
	return Math.max(min, Math.min(max, n));
}

function readConfigFromDisk(userDataPath: string, previous?: WatchdogConfig): WatchdogConfig {
	const fallback = previous ?? DEFAULTS;
	try {
		const settingsPath = path.join(userDataPath, 'User', 'settings.json');
		const raw = fs.readFileSync(settingsPath, 'utf-8');
		const parsed = parseJsonc(raw) as Record<string, unknown> | null;
		if (!parsed || typeof parsed !== 'object') {
			// W.43 partial-write retry: parser sees half-written file → keep previous
			// config instead of catastrophic fallback to DEFAULTS that throws away
			// the user's settings until the next change event.
			return { ...fallback };
		}
		const childTypesRaw = parsed['vibeide.diagnostics.idleWatchdog.includeChildProcessTypes'];
		const childTypes: readonly string[] = Array.isArray(childTypesRaw)
			? childTypesRaw.filter((x): x is string => typeof x === 'string' && x.length > 0)
			: fallback.includeChildProcessTypes;
		return {
			enabled: clampBool(parsed['vibeide.diagnostics.idleWatchdog.enabled'], DEFAULTS.enabled),
			intervalMinutes: clampInt(parsed['vibeide.diagnostics.idleWatchdog.intervalMinutes'], 1, 60, DEFAULTS.intervalMinutes),
			retentionDays: clampInt(parsed['vibeide.diagnostics.idleWatchdog.retentionDays'], 1, 90, DEFAULTS.retentionDays),
			includeProcessReport: clampBool(parsed['vibeide.diagnostics.idleWatchdog.includeProcessReport'], DEFAULTS.includeProcessReport),
			heapSnapshotOnHighRss: clampBool(parsed['vibeide.diagnostics.idleWatchdog.heapSnapshotOnHighRss'], DEFAULTS.heapSnapshotOnHighRss),
			heapSnapshotThresholdMB: clampInt(parsed['vibeide.diagnostics.idleWatchdog.heapSnapshotThresholdMB'], 100, 16000, DEFAULTS.heapSnapshotThresholdMB),
			snapshotCooldownMinutes: clampInt(parsed['vibeide.diagnostics.idleWatchdog.snapshotCooldownMinutes'], 5, 1440, DEFAULTS.snapshotCooldownMinutes),
			growthAlertMBPerMin: clampInt(parsed['vibeide.diagnostics.idleWatchdog.growthAlertMBPerMin'], 1, 200, DEFAULTS.growthAlertMBPerMin),
			sustainedAlertSamples: clampInt(parsed['vibeide.diagnostics.idleWatchdog.sustainedAlertSamples'], 1, 20, DEFAULTS.sustainedAlertSamples),
			heapSnapshotOnRapidGrowth: clampBool(parsed['vibeide.diagnostics.idleWatchdog.heapSnapshotOnRapidGrowth'], DEFAULTS.heapSnapshotOnRapidGrowth),
			snapshotGrowthDeltaMB: clampInt(parsed['vibeide.diagnostics.idleWatchdog.snapshotGrowthDeltaMB'], 50, 8000, DEFAULTS.snapshotGrowthDeltaMB),
			maxSnapshotsRetained: clampInt(parsed['vibeide.diagnostics.idleWatchdog.maxSnapshotsRetained'], 1, 20, DEFAULTS.maxSnapshotsRetained),
			includeChildProcessTypes: childTypes,
			maxLogsTotalMB: clampInt(parsed['vibeide.diagnostics.idleWatchdog.maxLogsTotalMB'], 50, 10000, DEFAULTS.maxLogsTotalMB),
			preOomHeapRatio: clampFloat(parsed['vibeide.diagnostics.idleWatchdog.preOomHeapRatio'], 0.5, 0.99, DEFAULTS.preOomHeapRatio),
			autoRestartOnPreOom: clampBool(parsed['vibeide.diagnostics.idleWatchdog.autoRestartOnPreOom'], DEFAULTS.autoRestartOnPreOom),
			compressOldJsonl: clampBool(parsed['vibeide.diagnostics.idleWatchdog.compressOldJsonl'], DEFAULTS.compressOldJsonl),
			adaptiveSampling: clampBool(parsed['vibeide.diagnostics.idleWatchdog.adaptiveSampling'], DEFAULTS.adaptiveSampling),
			statisticalOutlier: clampBool(parsed['vibeide.diagnostics.idleWatchdog.statisticalOutlier'], DEFAULTS.statisticalOutlier),
			commitAlertMB: clampInt(parsed['vibeide.diagnostics.idleWatchdog.commitAlertMB'], 0, 64000, DEFAULTS.commitAlertMB),
			burstSamplingEnabled: clampBool(parsed['vibeide.diagnostics.idleWatchdog.burstSamplingEnabled'], DEFAULTS.burstSamplingEnabled),
			burstSamplingSeconds: clampInt(parsed['vibeide.diagnostics.idleWatchdog.burstSamplingSeconds'], 5, 60, DEFAULTS.burstSamplingSeconds),
			burstDurationTicks: clampInt(parsed['vibeide.diagnostics.idleWatchdog.burstDurationTicks'], 1, 120, DEFAULTS.burstDurationTicks),
			snapshotRenderersOnCommitAlert: clampBool(parsed['vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitAlert'], DEFAULTS.snapshotRenderersOnCommitAlert),
			snapshotRenderersOnCommitSlope: clampBool(parsed['vibeide.diagnostics.idleWatchdog.snapshotRenderersOnCommitSlope'], DEFAULTS.snapshotRenderersOnCommitSlope),
		};
	} catch {
		// settings.json absent on first launch / read failed mid-write — keep previous
		// (or DEFAULTS for the very first read).
		return { ...fallback };
	}
}

function currentLogFile(logsDir: string): string {
	const d = new Date();
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return path.join(logsDir, `${yyyy}-${mm}-${dd}.jsonl`);
}

function msUntilNextUtcMidnight(now: Date): number {
	const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
	return next.getTime() - now.getTime();
}

interface ProcessReportRoot {
	readonly header?: { readonly osMachine?: string };
	readonly libuv?: ReadonlyArray<{ readonly type?: string }>;
	readonly resourceUsage?: { readonly maxRss?: number };
	readonly nativeStack?: readonly string[];
	readonly javascriptHeap?: unknown;
}

function buildProcessReportSubset(): WatchdogProcessReportSubset | undefined {
	const proc = process as unknown as { report?: { getReport?: () => unknown } };
	const getReport = proc.report?.getReport;
	if (typeof getReport !== 'function') { return undefined; }
	let report: ProcessReportRoot;
	try {
		report = getReport() as ProcessReportRoot;
	} catch {
		return undefined;
	}
	const libuvEntries = Array.isArray(report?.libuv) ? report.libuv : [];
	const handleTypes: Record<string, number> = {};
	let active = 0;
	for (const h of libuvEntries) {
		if (h && typeof h === 'object' && typeof h.type === 'string') {
			handleTypes[h.type] = (handleTypes[h.type] ?? 0) + 1;
			active += 1;
		}
	}
	const nativeStack = Array.isArray(report?.nativeStack) ? report.nativeStack.slice(0, 5) : undefined;
	return {
		osMachine: typeof report?.header?.osMachine === 'string' ? report.header.osMachine : undefined,
		libuvActiveHandles: active,
		libuvHandleTypes: Object.keys(handleTypes).length > 0 ? handleTypes : undefined,
		maxRss: typeof report?.resourceUsage?.maxRss === 'number' ? report.resourceUsage.maxRss : undefined,
		nativeStackTop: nativeStack,
	};
}

/**
 * Map Electron's `ProcessMetric.type` to our coarse `WatchdogProc`. Electron's
 * 'Utility' covers extension hosts AND other helper processes (network service,
 * audio service, etc.); we classify all of them as `'exthost'` with the
 * `serviceName` preserved in the sample's `note` field for disambiguation.
 *
 * @see https://www.electronjs.org/docs/latest/api/structures/process-metric
 */
function mapElectronTypeToProc(electronType: string): WatchdogProc {
	switch (electronType) {
		case 'Browser': return 'main';
		case 'Tab': return 'renderer';
		case 'Utility': return 'exthost';
		case 'GPU': return 'gpu';
		default: return 'utility';
	}
}

interface NodeProcWithInternals {
	_getActiveHandles?: () => unknown[];
	_getActiveRequests?: () => unknown[];
}

function readNodeHandleCount(): { handles: number; activeRequests: number } {
	const proc = process as unknown as NodeProcWithInternals;
	const handles = typeof proc._getActiveHandles === 'function' ? proc._getActiveHandles().length : -1;
	const activeRequests = typeof proc._getActiveRequests === 'function' ? proc._getActiveRequests().length : -1;
	return { handles, activeRequests };
}

/**
 * Per-process slope detector — running over the last N samples of a single
 * (proc, windowId, pid) triple. Slope > threshold MB/min sustained → caller can
 * dispatch user notification (W.5).
 *
 * **W.33 statistical mode:** when enabled, also tracks a longer history (100
 * samples) of slope values per process. Alert fires when the *current* slope
 * deviates >3σ from the historical mean — more robust on machines with high
 * baseline noise (e.g., loaded servers) where a fixed 5 MB/min threshold gives
 * false positives.
 */
class SlopeWatcher {
	private static readonly WINDOW_SIZE = 12;
	private static readonly HISTORY_SIZE = 100;
	private static readonly STATISTICAL_SIGMA = 3;

	private readonly _samples: { ts: number; rss: number }[] = [];
	private readonly _history: number[] = [];
	private _notified = false;

	push(ts: number, rss: number): { slopeMBPerMin: number; samples: number; outlier: boolean } {
		this._samples.push({ ts, rss });
		if (this._samples.length > SlopeWatcher.WINDOW_SIZE) {
			this._samples.shift();
		}
		if (this._samples.length < SlopeWatcher.WINDOW_SIZE) {
			return { slopeMBPerMin: 0, samples: this._samples.length, outlier: false };
		}
		const first = this._samples[0];
		const last = this._samples[this._samples.length - 1];
		const dtMin = (last.ts - first.ts) / 60_000;
		if (dtMin <= 0) { return { slopeMBPerMin: 0, samples: this._samples.length, outlier: false }; }
		const slope = ((last.rss - first.rss) / (1024 * 1024)) / dtMin;

		// W.33: rolling history of slope values for statistical detection.
		this._history.push(slope);
		if (this._history.length > SlopeWatcher.HISTORY_SIZE) {
			this._history.shift();
		}
		let outlier = false;
		if (this._history.length >= 20) {
			const mean = this._history.reduce((a, b) => a + b, 0) / this._history.length;
			const variance = this._history.reduce((a, b) => a + (b - mean) ** 2, 0) / this._history.length;
			const stddev = Math.sqrt(variance);
			outlier = stddev > 0.01 && (slope - mean) / stddev > SlopeWatcher.STATISTICAL_SIGMA;
		}
		return { slopeMBPerMin: slope, samples: this._samples.length, outlier };
	}

	get notified(): boolean { return this._notified; }
	markNotified(): void { this._notified = true; }

	private _sustainedCount = 0;
	/** Consecutive above-threshold evaluations. A single sliding window that happens to span a GC
	 * sawtooth (trough→peak) spikes the slope, but the next window collapses it. Requiring N
	 * consecutive triggers filters those transients while still catching a real sustained climb.
	 * Increments while `triggered`, resets to 0 otherwise. */
	recordTrigger(triggered: boolean): number {
		this._sustainedCount = triggered ? this._sustainedCount + 1 : 0;
		return this._sustainedCount;
	}
}

interface GcMetrics {
	count: number;
	majorCount: number;
	totalMs: number;
}

function attachGcObserver(): { snapshot: () => GcMetrics; dispose: () => void } | undefined {
	if (typeof PerformanceObserver !== 'function') { return undefined; }
	const metrics: GcMetrics = { count: 0, majorCount: 0, totalMs: 0 };
	try {
		const obs = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				metrics.count += 1;
				metrics.totalMs += entry.duration;
				// Node's `perf_hooks` GC `entry.detail.kind` enum:
				//   1 = Scavenge (young-generation, frequent + cheap)
				//   2 = Mark-Sweep-Compact (full GC — the «major» signal we want)
				//   4 = Incremental Marking (lead-up to MSC; NOT itself a major GC)
				//   8 = Weak Phantom Callback Processing (post-GC cleanup)
				//  15 = All (used in some Node versions as «full pass» marker)
				// Pre-W.41 also counted kind=4 as major, inflating `gcMajorCount` and
				// triggering false positives in pre-OOM heuristic (W.34).
				const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
				if (detail && (detail.kind === 2 || detail.kind === 15)) { metrics.majorCount += 1; }
			}
		});
		obs.observe({ entryTypes: ['gc'], buffered: false });
		return {
			snapshot: () => {
				const m = { ...metrics };
				metrics.count = 0;
				metrics.majorCount = 0;
				metrics.totalMs = 0;
				return m;
			},
			dispose: () => { try { obs.disconnect(); } catch { /* ignore */ } },
		};
	} catch {
		return undefined;
	}
}

/**
 * Serialised write queue — every line goes through `enqueue()` and is appended in
 * insertion order via a single in-flight `fs.appendFile` call. Prevents races when
 * renderer / ext-host samples arrive concurrently with main's interval tick.
 */
class WriteQueue {
	private _queue: string[] = [];
	private _flushing = false;
	private _disposed = false;

	constructor(private readonly _resolveFile: () => string) { }

	enqueue(jsonLine: string): void {
		if (this._disposed) { return; }
		this._queue.push(jsonLine);
		void this._drain();
	}

	private async _drain(): Promise<void> {
		if (this._flushing) { return; }
		this._flushing = true;
		try {
			while (this._queue.length > 0 && !this._disposed) {
				const batch = this._queue.splice(0).join('');
				const filePath = this._resolveFile();
				try {
					const dir = path.dirname(filePath);
					if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
				} catch { /* directory creation best-effort */ }
				await new Promise<void>((resolve) => {
					fs.appendFile(filePath, batch, () => resolve());
				});
			}
		} finally {
			this._flushing = false;
		}
	}

	/**
	 * W.44: synchronously flush any queued lines before disposing. Blocks the event
	 * loop briefly (typically <10ms for a handful of lines) — acceptable trade-off
	 * versus losing the final samples on Ctrl+C / hard kill.
	 */
	dispose(): void {
		if (this._disposed) { return; }
		if (this._queue.length > 0) {
			const finalBatch = this._queue.join('');
			this._queue = [];
			const filePath = this._resolveFile();
			try {
				const dir = path.dirname(filePath);
				if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
				fs.appendFileSync(filePath, finalBatch);
			} catch {
				// Best-effort; never throw from dispose.
			}
		}
		this._disposed = true;
	}
}

interface LastTickKey {
	proc: WatchdogProc;
	windowId?: number;
	pid?: number;
}

function keyFor(k: LastTickKey): string {
	return `${k.proc}|${k.windowId ?? 'x'}|${k.pid ?? 'x'}`;
}

/**
 * The watchdog service. Singleton in main; module-level helpers below preserve the
 * pre-W.0 export surface (`startVibeIdleWatchdog` / `stopVibeIdleWatchdog`) for
 * existing `src/main.ts` import sites.
 */
export class VibeIdleWatchdogService {

	private _config: WatchdogConfig;
	private _intervalTimer: TimerHandle | null = null;
	private _firstTickTimer: TimerHandle | null = null;
	private _midnightTimer: TimerHandle | null = null;
	private _settingsWatcher: fs.FSWatcher | null = null;
	private _settingsDebounceTimer: TimerHandle | null = null;
	private _writeQueue: WriteQueue;
	private _gcObserver: ReturnType<typeof attachGcObserver>;
	private readonly _logsDir: string;
	private readonly _snapshotsDir: string;
	private _tickCounter = 0;
	private readonly _lastTickTsByKey = new Map<string, string>();
	private readonly _slopeWatchers = new Map<string, SlopeWatcher>();
	/** Parallel slope watchers fed `privateBytes` (commit charge) — catches commit
	 * balloons the RSS watchers miss (renderer OOM 2026-05-30). Keyed identically. */
	private readonly _commitSlopeWatchers = new Map<string, SlopeWatcher>();
	private readonly _lastSnapshotByKey = new Map<string, number>();
	/** Renderer OS pids already auto-snapshotted this session (B): one heap dump per pid. */
	private readonly _rendererSnapshottedPids = new Set<number>();
	/** Last sampled RSS (MB) per process key — for per-tick growth-delta snapshot trigger (O.12). */
	private readonly _lastRssByKey = new Map<string, number>();
	/** W.52 — set once any renderer dies this session. While true, every main tick
	 * captures a full `process.report` subset (libuv-handle breakdown) so the post-crash
	 * `external` leak hunt gets per-tick granularity. Reset only on a fresh service start. */
	private _rendererCrashSeen = false;
	/** W.56 — renderer OS-pids alive at the last `suspend`. Compared on `resume` to
	 *  detect a renderer that died in the unobserved sleep window (timers frozen → no
	 *  sample, and the OS-level render-process-gone write may be lost). null = not suspended. */
	private _renderersAtSuspend: Set<number> | null = null;
	/** Stable bound refs so the powerMonitor listeners can be removed in `stop()`. */
	private readonly _onSuspendBound = () => this._onSuspend();
	private readonly _onResumeBound = () => this._onResume();
	/** 1630 — remaining ticks of fast (burst) sampling; > 0 means burst is active. */
	private _burstTicksRemaining = 0;
	/** Effective interval (ms) of the currently-armed timer — lets `_maybeReschedule`
	 * detect when burst/adaptive transitions require re-arming, without introspecting
	 * the native timer handle. */
	private _currentIntervalMs = 0;

	/**
	 * Slope-alert event. Multi-subscriber via standard `Emitter` — no longer the
	 * pre-W.22 single-callback `setSlopeNotifier`. Fires at most once per
	 * (proc, windowId, pid) per session (gated by `SlopeWatcher.markNotified`).
	 */
	private readonly _onSlopeAlert = new Emitter<{ proc: WatchdogProc; slopeMBPerMin: number; windowId?: number; pid?: number; metric?: 'rss' | 'commit' }>();
	readonly onSlopeAlert: Event<{ proc: WatchdogProc; slopeMBPerMin: number; windowId?: number; pid?: number; metric?: 'rss' | 'commit' }> = this._onSlopeAlert.event;

	/** Pre-OOM alert event (W.34/W.42). Fires when `heapUsed/heapLimit > preOomHeapRatio`. */
	private readonly _onPreOomAlert = new Emitter<WatchdogPreOomAlert>();
	readonly onPreOomAlert: Event<WatchdogPreOomAlert> = this._onPreOomAlert.event;

	private readonly _preOomNotified = new Set<string>();
	private readonly _latestSamples = new Map<string, WatchdogSampleBase>();
	private _statePersistTimer: TimerHandle | null = null;
	private _lastActivityTs = Date.now();

	constructor(private readonly _userDataPath: string) {
		this._logsDir = path.join(_userDataPath, LOGS_SUBDIR);
		this._snapshotsDir = path.join(_userDataPath, SNAPSHOTS_SUBDIR);
		this._writeQueue = new WriteQueue(() => currentLogFile(this._logsDir));
		this._config = readConfigFromDisk(_userDataPath);
		this._gcObserver = attachGcObserver();
		this._loadPersistedState();
	}

	/** Used by the bundler (W.11) and external diagnostics tooling. */
	get userDataPath(): string { return this._userDataPath; }
	get logsDir(): string { return this._logsDir; }
	get snapshotsDir(): string { return this._snapshotsDir; }

	start(): void {
		if (!this._config.enabled) { return; }
		// 1630 — any growth / pre-OOM alert kicks the sampler into burst mode so the
		// imminent spike is captured at second-resolution instead of slipping between
		// two base-interval samples. Listeners are released when the emitters are
		// disposed in `stop()`.
		this.onSlopeAlert(() => this._enterBurst());
		this.onPreOomAlert(() => this._enterBurst());
		this._cleanupOldLogs();
		this._compressOldJsonl();
		this._enforceLogSizeCap();
		this._scheduleFirstTick();
		this._scheduleInterval();
		this._scheduleMidnightRotation();
		this._watchSettings();
		this._schedulePersistState();
		this._installSignalHandler();
		this._installPowerHandlers();
	}

	/**
	 * W.56 — power-event bracketing. The sampler's timers are frozen while the
	 * machine sleeps, so an overnight renderer OOM lands in a blind window: no
	 * sample, no crash entry, no snapshot (incident 2026-05-31: renderer flat at
	 * 243 MB until sleep, then gone — nothing recorded). Bracket the sleep with a
	 * `pre-suspend` tick (last-known-good) and a `post-resume` tick, and on resume
	 * record any renderer that vanished across the gap.
	 */
	private _installPowerHandlers(): void {
		try {
			powerMonitor.on('suspend', this._onSuspendBound);
			powerMonitor.on('resume', this._onResumeBound);
		} catch {
			// powerMonitor may be unavailable in headless/test envs — best-effort.
		}
	}

	private _liveRendererPids(): Set<number> {
		const out = new Set<number>();
		try {
			for (const m of app.getAppMetrics()) {
				if (m.type === 'Tab' && m.pid !== process.pid) { out.add(m.pid); }
			}
		} catch {
			// getAppMetrics can throw very early / very late in app lifecycle.
		}
		return out;
	}

	private _onSuspend(): void {
		// Capture the renderer set + write a last-known-good tick before the freeze.
		this._renderersAtSuspend = this._liveRendererPids();
		this._tickMain('pre-suspend');
	}

	private _onResume(): void {
		const before = this._renderersAtSuspend;
		this._renderersAtSuspend = null;
		// Detect renderers that died during the sleep window BEFORE the post-resume
		// tick reconciles (and cleans) their tracking keys — so `recordCrash` can
		// still resolve `lastTickRef` to the pre-suspend sample.
		if (before && before.size > 0) {
			const live = this._liveRendererPids();
			for (const pid of before) {
				if (!live.has(pid)) {
					this.recordCrash({ proc: 'renderer', pid, reason: 'gone-during-suspend' });
				}
			}
		}
		this._tickMain('post-resume');
	}

	/**
	 * W.19 — `kill -USR2 <pid>` triggers an out-of-band heap snapshot. Useful for
	 * remote / headless diagnostics on Linux + macOS where Command Palette is
	 * unavailable. Windows has no native SIGUSR2; harmless no-op there.
	 */
	private _installSignalHandler(): void {
		if (process.platform === 'win32') { return; }
		try {
			process.on('SIGUSR2', () => {
				this.captureMainHeapSnapshot('signal');
			});
		} catch {
			// Some environments deny signal handler installation — best-effort.
		}
	}

	stop(): void {
		this._clearTimer('_firstTickTimer');
		this._clearTimer('_intervalTimer');
		this._clearTimer('_midnightTimer');
		if (this._statePersistTimer !== null) {
			clearInterval(this._statePersistTimer);
			this._statePersistTimer = null;
		}
		// Pending settings-debounce timer (W.41 round-3 fix): without explicit
		// clear, a debounced reload scheduled before `stop()` could fire after
		// shutdown and call `_reloadConfig()` on a disposed service.
		if (this._settingsDebounceTimer !== null) {
			clearTimeout(this._settingsDebounceTimer);
			this._settingsDebounceTimer = null;
		}
		this._settingsWatcher?.close();
		this._settingsWatcher = null;
		try {
			powerMonitor.removeListener('suspend', this._onSuspendBound);
			powerMonitor.removeListener('resume', this._onResumeBound);
		} catch { /* best-effort */ }
		this._gcObserver?.dispose();
		this._persistState(); // final write before drain (W.45)
		this._writeQueue.dispose(); // synchronous drain (W.44)
		this._onSlopeAlert.dispose();
		this._onPreOomAlert.dispose();
	}

	/** Snapshot of live state of every process tracked since last `start()`. */
	getCurrentSnapshot(): { capturedAt: string; samples: readonly WatchdogSampleBase[] } {
		const samples = Array.from(this._latestSamples.values());
		return { capturedAt: new Date().toISOString(), samples };
	}

	/** Public trigger of a main heap snapshot — used by Activity Bar / AI diagnosis (W.47/W.36). */
	triggerMainHeapSnapshot(): WatchdogSnapshotEntry | null {
		return this.captureMainHeapSnapshot('manual');
	}

	/**
	 * IPC entry point: external (renderer / ext-host) sample arrives via channel.
	 */
	acceptExternalSample(sample: WatchdogSampleBase): void {
		this._lastTickTsByKey.set(keyFor({ proc: sample.proc, windowId: sample.windowId, pid: sample.pid }), sample.ts);
		this._writeQueue.enqueue(JSON.stringify(sample) + '\n');
		this._evaluateSlope(sample);
		this._maybeTriggerSnapshot(sample);
		// W.50 — any active renderer sample (idleSec === 0 or undefined) resets
		// adaptive idle clock. Pull from the sample's own field if present.
		if (typeof sample.idleSec === 'number' && sample.idleSec < 60) {
			this._lastActivityTs = Date.now();
		}
	}

	/**
	 * IPC entry point: external process records a crash entry (rare — usually
	 * crashes are recorded by main observing the child process). Provided for
	 * symmetry / future use.
	 */
	acceptExternalCrash(entry: WatchdogCrashEntry): void {
		this._writeQueue.enqueue(JSON.stringify(entry) + '\n');
	}

	acceptExternalSnapshot(entry: WatchdogSnapshotEntry): void {
		this._writeQueue.enqueue(JSON.stringify(entry) + '\n');
	}

	/**
	 * Record a render-process-gone / child-process-gone correlated entry, including
	 * a reference to the last known sample's `ts` for the (proc, windowId) pair
	 * (W.3 — correlation in a single file).
	 */
	recordCrash(args: {
		proc: WatchdogProc;
		windowId?: number;
		pid?: number;
		reason?: string;
		exitCode?: number;
		signal?: string;
	}): void {
		const k = keyFor({ proc: args.proc, windowId: args.windowId, pid: args.pid });
		const lastTickRef = this._lastTickTsByKey.get(k);
		// W.52 — once a renderer dies, force a full process.report on every subsequent
		// main tick (see `_buildMainSample`) so the post-crash external-leak hunt gets
		// per-tick libuv-handle granularity instead of the default every-10th-tick rate.
		if (args.proc === 'renderer') {
			this._rendererCrashSeen = true;
		}
		const entry: WatchdogCrashEntry = {
			v: 1,
			type: 'crash',
			ts: new Date().toISOString(),
			proc: args.proc,
			pid: args.pid,
			windowId: args.windowId,
			reason: args.reason,
			exitCode: args.exitCode,
			signal: args.signal,
			lastTickRef,
		};
		this._writeQueue.enqueue(JSON.stringify(entry) + '\n');
		this._cleanupKey(k);
	}

	recordExit(args: {
		proc: WatchdogProc;
		windowId?: number;
		pid?: number;
		exitCode?: number;
		signal?: string;
	}): void {
		const k = keyFor({ proc: args.proc, windowId: args.windowId, pid: args.pid });
		const lastTickRef = this._lastTickTsByKey.get(k);
		const entry: WatchdogCrashEntry = {
			v: 1,
			type: 'exit',
			ts: new Date().toISOString(),
			proc: args.proc,
			pid: args.pid,
			windowId: args.windowId,
			exitCode: args.exitCode,
			signal: args.signal,
			lastTickRef,
		};
		this._writeQueue.enqueue(JSON.stringify(entry) + '\n');
		this._cleanupKey(k);
	}

	/**
	 * Reclaim per-process state. Without this, every renderer crash / ext-host
	 * restart leaves a zombie `SlopeWatcher` / `_lastTickTsByKey` / `_lastSnapshotByKey`
	 * entry alive forever — ironic memory leak in the diagnostic tool itself (W.22 audit).
	 */
	private _cleanupKey(k: string): void {
		this._slopeWatchers.delete(k);
		this._commitSlopeWatchers.delete(k);
		this._lastTickTsByKey.delete(k);
		this._lastSnapshotByKey.delete(k);
	}

	/**
	 * Reconcile internal state with the set of live PIDs known to Electron.
	 * Called on every main tick after `_sampleElectronChildProcesses` builds the
	 * snapshot of children. Any tracked `(proc, pid)` triple whose PID is no longer
	 * present is reclaimed — this catches processes that died silently without
	 * a `child-process-gone` event (zygote helpers, transient utilities).
	 *
	 * Iterates `_lastTickTsByKey` because that's the master set of all sampled
	 * processes — `_slopeWatchers` only contains entries that produced 12+ samples
	 * (W.22 round-3 fix: pre-W.41 reconcile missed short-lived processes whose
	 * entries existed in `_lastTickTsByKey` / `_lastSnapshotByKey` but not in
	 * `_slopeWatchers`, leaking them indefinitely).
	 */
	private _reconcileLiveProcesses(livePids: ReadonlySet<number>): void {
		// Snapshot keys before mutation to avoid iterator invalidation on delete.
		const trackedKeys = Array.from(this._lastTickTsByKey.keys());
		for (const key of trackedKeys) {
			const parts = key.split('|');
			const pidStr = parts[2];
			// `pidStr === 'x'` means the key didn't carry a pid (pre-W.0 lines /
			// callers that omit). Skip — we can't reconcile what we don't know.
			if (pidStr === 'x') { continue; }
			const pid = Number(pidStr);
			if (Number.isFinite(pid) && pid !== process.pid && !livePids.has(pid)) {
				this._cleanupKey(key);
			}
		}
	}

	/**
	 * Force a heap snapshot of the main process to disk. Returns the entry written.
	 */
	captureMainHeapSnapshot(trigger: WatchdogSnapshotEntry['trigger']): WatchdogSnapshotEntry | null {
		try {
			if (!fs.existsSync(this._snapshotsDir)) { fs.mkdirSync(this._snapshotsDir, { recursive: true }); }
			const ts = new Date();
			const ymd = ts.toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 15);
			const fileName = `${ymd}-main-${process.pid}.heapsnapshot`;
			const filePath = path.join(this._snapshotsDir, fileName);
			v8.writeHeapSnapshot(filePath);
			const stat = fs.statSync(filePath);
			// Sanity-check the file actually contains data — `writeHeapSnapshot` can
			// return without throwing on disk-full / permission errors leaving an
			// empty file behind. Pre-W.41 a 0-byte snapshot would still be logged
			// as success (W.26 acceptance item).
			if (stat.size === 0) {
				try { fs.unlinkSync(filePath); } catch { /* ignore */ }
				return null;
			}
			const entry: WatchdogSnapshotEntry = {
				v: 1,
				type: 'snapshot',
				ts: ts.toISOString(),
				proc: 'main',
				pid: process.pid,
				path: filePath,
				sizeBytes: stat.size,
				trigger,
			};
			this._writeQueue.enqueue(JSON.stringify(entry) + '\n');
			this._rotateSnapshots();
			// Update cooldown bookkeeping so the auto-trigger respects this manual
			// snapshot (pre-W.41 manual snapshot bypassed `_lastSnapshotByKey`, and
			// the next auto-snapshot could fire immediately, defeating the cooldown).
			this._lastSnapshotByKey.set(keyFor({ proc: 'main', pid: process.pid }), Date.now());
			return entry;
		} catch {
			return null;
		}
	}

	/** Find the (first, non-destroyed) webContents backed by `osPid`. Best-effort. */
	private _webContentsForPid(osPid: number): Electron.WebContents | undefined {
		try {
			for (const wc of webContents.getAllWebContents()) {
				if (wc.isDestroyed()) { continue; }
				let p: number;
				try { p = wc.getOSProcessId(); } catch { continue; }
				if (p === osPid) { return wc; }
			}
		} catch { /* ignore */ }
		return undefined;
	}

	/** A: compact identity label for a renderer pid — `<type>:<host|title>` (e.g. `webview:books.abxb.ru`,
	 *  `window:VibeIDE`). Lets a commit-charge balloon be attributed to a specific process. */
	private _rendererLabel(osPid: number): string | undefined {
		const wc = this._webContentsForPid(osPid);
		if (!wc) { return undefined; }
		try {
			const type = wc.getType();
			let host = '';
			try {
				const url = wc.getURL();
				if (url) { try { host = new URL(url).host || url.slice(0, 50); } catch { host = url.slice(0, 50); } }
			} catch { /* ignore */ }
			let title = '';
			try { title = wc.getTitle() || ''; } catch { /* ignore */ }
			const label = host || title;
			return label ? `${type}:${label}` : type;
		} catch {
			return undefined;
		}
	}

	/**
	 * B: capture a heap snapshot of a RENDERER process (by OS pid) via Electron's
	 * `webContents.takeHeapSnapshot` — main can snapshot any renderer, so the offending
	 * process (not just main) gets dumped. Heavy + async; callers gate by config + once-per-pid.
	 */
	async captureRendererHeapSnapshot(osPid: number, trigger: WatchdogSnapshotEntry['trigger']): Promise<WatchdogSnapshotEntry | null> {
		try {
			const wc = this._webContentsForPid(osPid);
			if (!wc) { return null; }
			if (!fs.existsSync(this._snapshotsDir)) { fs.mkdirSync(this._snapshotsDir, { recursive: true }); }
			const ts = new Date();
			const ymd = ts.toISOString().slice(0, 19).replace(/[-:T]/g, '').slice(0, 15);
			const fileName = `${ymd}-renderer-${osPid}.heapsnapshot`;
			const filePath = path.join(this._snapshotsDir, fileName);
			await wc.takeHeapSnapshot(filePath);
			const stat = fs.statSync(filePath);
			if (stat.size === 0) {
				try { fs.unlinkSync(filePath); } catch { /* ignore */ }
				return null;
			}
			const entry: WatchdogSnapshotEntry = {
				v: 1,
				type: 'snapshot',
				ts: ts.toISOString(),
				proc: 'renderer',
				pid: osPid,
				path: filePath,
				sizeBytes: stat.size,
				trigger,
			};
			this._writeQueue.enqueue(JSON.stringify(entry) + '\n');
			this._rotateSnapshots();
			return entry;
		} catch {
			return null;
		}
	}

	private _scheduleFirstTick(): void {
		// 10s after startup — matches pre-W.0 behaviour. Captures baseline before
		// user interaction inflates working set.
		this._firstTickTimer = setTimeout(() => this._tickMain('first-tick'), 10_000) as unknown as TimerHandle;
		unrefTimer(this._firstTickTimer);
	}

	private _scheduleInterval(): void {
		const intervalMs = this._effectiveIntervalMs();
		this._currentIntervalMs = intervalMs;
		this._intervalTimer = setInterval(() => this._tickMain(), intervalMs) as unknown as TimerHandle;
		unrefTimer(this._intervalTimer);
	}

	/**
	 * W.50/1630 — resolve the effective interval. Burst (1630) shrinks it after a
	 * growth/pre-OOM alert; adaptive (W.50) stretches it when idle > 1h. Pure decision
	 * in `computeSamplingIntervalMs`; the timer is re-armed by `_maybeReschedule()`.
	 */
	private _effectiveIntervalMs(): number {
		return computeSamplingIntervalMs({
			burstTicksRemaining: this._burstTicksRemaining,
			burstSeconds: this._config.burstSamplingSeconds,
			adaptive: this._config.adaptiveSampling,
			intervalMinutes: this._config.intervalMinutes,
			idleMs: Date.now() - this._lastActivityTs,
		});
	}

	/**
	 * 1630 — enter burst sampling: fast ticks for `burstDurationTicks` ticks so an
	 * imminent spike is captured instead of slipping between two base-interval samples.
	 * Idempotent (re-arms the counter), cheap, no-op when disabled. Re-arms the timer
	 * immediately so the speed-up doesn't wait for the next (slow) tick to land.
	 */
	private _enterBurst(): void {
		if (!this._config.burstSamplingEnabled) { return; }
		this._burstTicksRemaining = this._config.burstDurationTicks;
		this._maybeReschedule();
	}

	/**
	 * Re-arm the interval timer when the effective interval changed — covers both
	 * adaptive idle↔active transitions (W.50) and burst enter/exit (1630). Cheap: a
	 * single comparison against the currently-armed interval (`_currentIntervalMs`),
	 * which `_scheduleInterval()` keeps in sync.
	 */
	private _maybeReschedule(): void {
		if (this._intervalTimer === null) { return; }
		const targetMs = this._effectiveIntervalMs();
		if (targetMs !== this._currentIntervalMs) {
			this._clearTimer('_intervalTimer');
			this._scheduleInterval();
		}
	}

	/** External signal: any process reports user-activity → reset idle clock for adaptive mode. */
	notifyActivity(): void {
		this._lastActivityTs = Date.now();
	}

	private _scheduleMidnightRotation(): void {
		const ms = msUntilNextUtcMidnight(new Date());
		this._midnightTimer = setTimeout(() => {
			this._cleanupOldLogs();
			this._scheduleMidnightRotation(); // re-arm for next day
		}, ms) as unknown as TimerHandle;
		unrefTimer(this._midnightTimer);
	}

	private _watchSettings(): void {
		try {
			const settingsPath = path.join(this._userDataPath, 'User', 'settings.json');
			if (!fs.existsSync(settingsPath)) { return; }
			this._settingsWatcher = fs.watch(settingsPath, () => {
				// Use the instance field instead of a closure-local so `stop()` can
				// cancel a pending debounced reload — pre-W.41 the timer was only
				// reachable from inside this closure, so shutdown left it dangling.
				if (this._settingsDebounceTimer !== null) {
					clearTimeout(this._settingsDebounceTimer);
				}
				this._settingsDebounceTimer = setTimeout(() => {
					this._settingsDebounceTimer = null;
					this._reloadConfig();
				}, 500) as unknown as TimerHandle;
				unrefTimer(this._settingsDebounceTimer);
			});
		} catch {
			// File watching failed (e.g., on a network share) — silently degrade.
		}
	}

	private _reloadConfig(): void {
		// W.43 — pass current config as fallback so partial-write reads don't reset
		// to DEFAULTS. Parser sees half-written file → keeps `this._config`.
		const next = readConfigFromDisk(this._userDataPath, this._config);
		const prev = this._config;
		this._config = next;
		if (prev.intervalMinutes !== next.intervalMinutes) {
			this._clearTimer('_intervalTimer');
			if (next.enabled) { this._scheduleInterval(); }
		}
		if (prev.enabled !== next.enabled) {
			if (!next.enabled) {
				this._clearTimer('_intervalTimer');
				this._clearTimer('_firstTickTimer');
			} else if (this._intervalTimer === null) {
				this._scheduleInterval();
			}
		}
	}

	private _clearTimer(key: '_intervalTimer' | '_firstTickTimer' | '_midnightTimer'): void {
		// Cast `this` to a writable map of timer handles — TS strict mode rejects
		// the bare `this[key]` indexing because the union of private-field names
		// isn't a structural key of the class type. Equivalent at runtime; the
		// cast is local to this helper and doesn't escape.
		const self = this as unknown as Record<typeof key, TimerHandle | null>;
		const t = self[key];
		if (t !== null) {
			if (key === '_intervalTimer') { clearInterval(t); }
			else { clearTimeout(t); }
			self[key] = null;
		}
	}

	private _tickMain(note?: string): void {
		try {
			this._tickCounter += 1;
			const sample = this._buildMainSample(note);
			this._lastTickTsByKey.set(keyFor({ proc: 'main', pid: process.pid }), sample.ts);
			this._writeQueue.enqueue(JSON.stringify(sample) + '\n');
			this._evaluateSlope(sample);
			this._maybeTriggerSnapshot(sample);
			// W.2 — sample ext-host, GPU, utility processes via Electron's getAppMetrics().
			// Renderers (`type === 'Tab'`) are skipped here — they self-sample via W.1
			// renderer-side contribution to provide window-context (workspaceHash, idleSec).
			this._sampleElectronChildProcesses(note);
			// 1630 — count down the burst window; when it hits 0, `_maybeReschedule`
			// restores the base interval on this same tick.
			if (this._burstTicksRemaining > 0) {
				this._burstTicksRemaining -= 1;
			}
			// W.50/1630 — re-arm if the effective interval changed (idle/active flip or burst enter/exit).
			this._maybeReschedule();
			// W.26 — periodic budget check (cheap; just sums sizes once per tick).
			if (this._tickCounter % 12 === 0) { this._enforceLogSizeCap(); }
		} catch {
			// Never throw from a timer callback — keeps the IDE event loop healthy.
		}
	}

	private _sampleElectronChildProcesses(note?: string): void {
		let metrics: readonly Electron.ProcessMetric[];
		try {
			metrics = app.getAppMetrics();
		} catch {
			return;
		}
		const tsString = new Date().toISOString();
		const livePids = new Set<number>();
		const includeTypes = this._config.includeChildProcessTypes;
		for (const m of metrics) {
			livePids.add(m.pid);
			if (m.pid === process.pid) { continue; }             // main — already sampled
			// Renderers (`Tab`) used to be skipped here (covered by the W.1 renderer-side
			// self-sample). But that self-sample reads `performance.memory` — JS heap only,
			// no commit — and carries a bogus pid (-1). The renderer OOM 2026-05-30 was a
			// commit-charge balloon (~13 GB private commit at ~400 MB working set), invisible
			// to every existing signal. main is the ONLY place that can read a renderer's
			// `privateBytes` (with its real OS pid), so we now emit a main-side commit-probe
			// for renderers too. They are exempt from `includeChildProcessTypes` (that filter
			// targets helper utilities, not the renderer we most need to watch).
			const isRenderer = m.type === 'Tab';
			if (!isRenderer && !includeTypes.includes(m.type)) { continue; } // user-configurable filter (W.22)
			const proc = mapElectronTypeToProc(m.type);
			// `workingSetSize` is in KILOBYTES per Electron docs; multiply to bytes for
			// schema consistency with `process.memoryUsage().rss`.
			const rss = (m.memory?.workingSetSize ?? 0) * 1024;
			// `privateBytes` (KB → bytes): private commit charge. 0/absent → undefined
			// («not measured») rather than a misleading literal 0.
			const privBytesKb = m.memory?.privateBytes;
			const privateBytes = typeof privBytesKb === 'number' && privBytesKb > 0 ? privBytesKb * 1024 : undefined;
			// Tag renderer probes so readers don't confuse them with the heap-bearing W.1
			// self-sample of the same window.
			const tickNote = isRenderer ? (note ? `${note} commit-probe` : 'commit-probe') : note;
			// A: label renderers with their webview identity (type + host/title) so a future
			// commit-charge balloon is attributable to a specific process, not a bare pid.
			const rendererLabel = isRenderer ? this._rendererLabel(m.pid) : undefined;
			const uptimeSec = m.creationTime ? Math.round((Date.now() - m.creationTime) / 1000) : 0;
			const sample: WatchdogSampleBase = {
				v: 1,
				type: 'sample',
				ts: tsString,
				proc,
				pid: m.pid,
				uptimeSec,
				rss,
				privateBytes,
				// `heapUsed` / `heapTotal` intentionally omitted — `app.getAppMetrics()`
				// does not expose V8 heap of children. Pre-W.22 emitted `0` here, which
				// readers misinterpreted as «really zero»; undefined = «not measured».
				note: this._composeChildNote(tickNote, m.serviceName, rendererLabel ?? m.name),
			};
			this._lastTickTsByKey.set(keyFor({ proc, pid: m.pid }), sample.ts);
			this._writeQueue.enqueue(JSON.stringify(sample) + '\n');
			this._evaluateSlope(sample);
			// B (crash-report 2026-05-30): auto-capture the OFFENDING renderer's heap when its
			// private commit crosses the alert. Off by default (heavy: multi-GB file near OOM),
			// once per pid. `webContents.takeHeapSnapshot` works from main, so the old «children
			// need CDP attach» note no longer holds.
			if (isRenderer && privateBytes !== undefined && this._config.snapshotRenderersOnCommitAlert
				&& this._config.commitAlertMB > 0 && privateBytes / (1024 * 1024) >= this._config.commitAlertMB
				&& !this._rendererSnapshottedPids.has(m.pid)) {
				this._rendererSnapshottedPids.add(m.pid);
				void this.captureRendererHeapSnapshot(m.pid, 'threshold');
			}
		}
		this._reconcileLiveProcesses(livePids);
	}

	private _composeChildNote(tickNote: string | undefined, serviceName?: string, name?: string): string | undefined {
		// Sanitise: strip newlines / control chars that would corrupt `.jsonl` lines
		// and trim semicolons (used as separator between tickNote and label).
		const sanitize = (s: string | undefined): string | undefined => s?.replace(/[\r\n\t]/g, ' ').replace(/;+/g, ',').trim() || undefined;
		const cleanTick = sanitize(tickNote);
		const cleanLabel = sanitize(serviceName) ?? sanitize(name);
		if (cleanTick && cleanLabel) { return `${cleanTick}; ${cleanLabel}`; }
		return cleanTick ?? cleanLabel ?? undefined;
	}

	private _buildMainSample(note?: string): WatchdogSampleBase {
		const mem = process.memoryUsage();
		const heapStats = v8.getHeapStatistics();
		const { handles, activeRequests } = readNodeHandleCount();
		const gc = this._gcObserver?.snapshot();
		// Include process.report every 10th tick when enabled — keeps file size reasonable.
		// W.52: after a renderer crash, force it EVERY tick regardless of config so the
		// post-crash `external` leak gets per-tick libuv-handle breakdown.
		const includeReport = (this._config.includeProcessReport && (this._tickCounter % 10 === 0)) || this._rendererCrashSeen;
		// Markers — make incident windows trivially filterable in the .jsonl
		// (`jq 'select(.note|test("post-renderer-crash"))'` / `test("burst")`).
		// W.52: every main sample after a renderer death. 1630: samples taken while burst
		// sampling is active.
		const markers: string[] = [];
		if (note) { markers.push(note); }
		if (this._rendererCrashSeen) { markers.push('post-renderer-crash'); }
		if (this._burstTicksRemaining > 0) { markers.push('burst'); }
		const effectiveNote = markers.length > 0 ? markers.join(' ') : undefined;
		const sample: WatchdogSampleBase = {
			v: 1,
			type: 'sample',
			ts: new Date().toISOString(),
			proc: 'main',
			pid: process.pid,
			uptimeSec: Math.round(process.uptime()),
			rss: mem.rss,
			heapUsed: mem.heapUsed,
			heapTotal: mem.heapTotal,
			// `heap_size_limit` from V8 = hard upper bound (`--max-old-space-size`
			// applied). Lets pre-OOM heuristic (W.42) compute `heapUsed / heapLimit`
			// for main process — symmetric with renderer's `jsHeapSizeLimit`.
			heapLimit: heapStats.heap_size_limit,
			external: mem.external,
			arrayBuffers: mem.arrayBuffers,
			handles,
			activeRequests,
			gcCount: gc?.count,
			gcMajorCount: gc?.majorCount,
			gcTotalMs: gc?.totalMs,
			note: effectiveNote,
			report: includeReport ? buildProcessReportSubset() : undefined,
			// XML normalization counters live in the same (main) process as the LLM stream parser, so
			// we read them directly — no IPC. Dev-diagnostic: shows which fallback layer carried load.
			xmlNormalize: getNormalizeCounters(),
		};
		return sample;
	}

	private _evaluateSlope(sample: WatchdogSampleBase): void {
		const k = keyFor({ proc: sample.proc, windowId: sample.windowId, pid: sample.pid });
		let watcher = this._slopeWatchers.get(k);
		if (!watcher) {
			watcher = new SlopeWatcher();
			this._slopeWatchers.set(k, watcher);
		}
		const { slopeMBPerMin, outlier } = watcher.push(Date.parse(sample.ts), sample.rss);
		// Track the latest sample per process for `getCurrentSnapshot()` (W.7/W.47).
		this._latestSamples.set(k, sample);
		const trigger = this._config.statisticalOutlier
			? outlier
			: slopeMBPerMin > this._config.growthAlertMBPerMin;
		// Require the slope to stay above threshold for `sustainedAlertSamples` consecutive
		// evaluations: a single sliding window spanning a GC sawtooth trough→peak spikes high, but
		// the next window collapses it; a real leak sustains. Filters false "collect crash report"
		// prompts on healthy churn. recordTrigger() resets the streak whenever the slope drops back.
		const sustained = watcher.recordTrigger(trigger);
		if (!watcher.notified && trigger && sustained >= this._config.sustainedAlertSamples) {
			watcher.markNotified();
			this._onSlopeAlert.fire({
				proc: sample.proc,
				slopeMBPerMin,
				windowId: sample.windowId,
				pid: sample.pid,
				metric: 'rss',
			});
		}
		// Commit-charge slope — parallel watcher fed `privateBytes`. Catches a balloon
		// that grows in private commit while working set stays flat (renderer OOM
		// 2026-05-30). Only main-sampled children carry `privateBytes`, so this is the
		// sole growth signal for them; one-shot per key via its own `markNotified`.
		if (sample.privateBytes !== undefined) {
			let commitWatcher = this._commitSlopeWatchers.get(k);
			if (!commitWatcher) {
				commitWatcher = new SlopeWatcher();
				this._commitSlopeWatchers.set(k, commitWatcher);
			}
			const { slopeMBPerMin: commitSlope, outlier: commitOutlier } = commitWatcher.push(Date.parse(sample.ts), sample.privateBytes);
			const commitTrigger = this._config.statisticalOutlier
				? commitOutlier
				: commitSlope > this._config.growthAlertMBPerMin;
			const commitSustained = commitWatcher.recordTrigger(commitTrigger);
			if (!commitWatcher.notified && commitTrigger && commitSustained >= this._config.sustainedAlertSamples) {
				commitWatcher.markNotified();
				this._onSlopeAlert.fire({
					proc: sample.proc,
					slopeMBPerMin: commitSlope,
					windowId: sample.windowId,
					pid: sample.pid,
					metric: 'commit',
				});
				// W.55: snapshot the renderer WHILE the commit balloon is forming (slope),
				// not only at the absolute `commitAlertMB`. Shares `_rendererSnapshottedPids`
				// with the threshold path so a pid is dumped at most once. `sample.pid` is the
				// real OS pid (main-side commit-probe), which `webContents.takeHeapSnapshot` needs.
				if (this._config.snapshotRenderersOnCommitSlope && sample.proc === 'renderer'
					&& sample.pid !== undefined && sample.pid > 0 && !this._rendererSnapshottedPids.has(sample.pid)) {
					this._rendererSnapshottedPids.add(sample.pid);
					void this.captureRendererHeapSnapshot(sample.pid, 'slope');
				}
			}
		}
		// W.34/W.42 pre-OOM evaluation — orthogonal to slope alert, may fire on
		// the same sample if the heap ratio crosses threshold.
		this._evaluatePreOom(sample, slopeMBPerMin);
	}

	private _maybeTriggerSnapshot(sample: WatchdogSampleBase): void {
		const k = keyFor({ proc: sample.proc, windowId: sample.windowId, pid: sample.pid });
		const rssMB = sample.rss / (1024 * 1024);
		const prevRssMB = this._lastRssByKey.get(k);
		this._lastRssByKey.set(k, rssMB);

		// Reason 1 (W.4): absolute RSS over threshold.
		const overThreshold = this._config.heapSnapshotOnHighRss
			&& rssMB >= this._config.heapSnapshotThresholdMB;
		// Reason 2 (O.12): rapid single-tick growth — RSS jumped by >= snapshotGrowthDeltaMB
		// since the previous sample for THIS process. Catches a balloon that crashes before
		// crossing the absolute threshold (the renderer OOM in crash-report 2026-05-25 spiked
		// from ~580 MB, so the threshold rule never fired). Note: an inter-tick spike faster
		// than `intervalMinutes` still slips through — lower the interval when hunting one.
		const rapidGrowth = this._config.heapSnapshotOnRapidGrowth
			&& prevRssMB !== undefined
			&& (rssMB - prevRssMB) >= this._config.snapshotGrowthDeltaMB;

		if (!overThreshold && !rapidGrowth) { return; }
		const last = this._lastSnapshotByKey.get(k) ?? 0;
		const cooldownMs = this._config.snapshotCooldownMinutes * 60 * 1000;
		const now = Date.now();
		if (now - last < cooldownMs) { return; }
		this._lastSnapshotByKey.set(k, now);
		// Only main can snapshot itself synchronously; renderer/exthost snapshots are triggered
		// by their own contributions (see W.4). For those the growth signal still lands in the
		// .jsonl + slope alert for offline review.
		if (sample.proc === 'main') {
			this.captureMainHeapSnapshot(overThreshold ? 'threshold' : 'slope');
		}
	}

	private _rotateSnapshots(): void {
		try {
			if (!fs.existsSync(this._snapshotsDir)) { return; }
			const files = fs.readdirSync(this._snapshotsDir)
				.filter(f => f.endsWith('.heapsnapshot'))
				.map(f => ({ name: f, full: path.join(this._snapshotsDir, f), mtime: fs.statSync(path.join(this._snapshotsDir, f)).mtimeMs }))
				.sort((a, b) => b.mtime - a.mtime);
			const excess = files.slice(this._config.maxSnapshotsRetained);
			for (const f of excess) {
				try { fs.unlinkSync(f.full); } catch { /* ignore */ }
			}
		} catch {
			// Snapshot rotation is best-effort; never throw out of a hot path.
		}
	}

	private _cleanupOldLogs(): void {
		try {
			if (!fs.existsSync(this._logsDir)) { return; }
			const cutoffMs = Date.now() - this._config.retentionDays * 24 * 60 * 60 * 1000;
			for (const file of fs.readdirSync(this._logsDir)) {
				const m = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
				if (!m) { continue; }
				const fileDateMs = Date.parse(`${m[1]}T00:00:00.000Z`);
				if (!Number.isFinite(fileDateMs)) { continue; }
				if (fileDateMs < cutoffMs) {
					try { fs.unlinkSync(path.join(this._logsDir, file)); } catch { /* ignore */ }
				}
			}
			// Heap snapshots age out on the SAME retention clock as the .jsonl logs. The count-based
			// `_rotateSnapshots` only runs on capture, so without this a quiet period (no new
			// captures) preserved 130MB+ snapshots indefinitely — and every crash-report bundle
			// dragged those stale artefacts along (observed: May 30/31 snapshots still shipping in
			// June 6 bundles, 45MB per export). Runs at startup + periodic tick alongside log cleanup.
			if (fs.existsSync(this._snapshotsDir)) {
				for (const file of fs.readdirSync(this._snapshotsDir)) {
					if (!file.endsWith('.heapsnapshot')) { continue; }
					const full = path.join(this._snapshotsDir, file);
					try {
						if (fs.statSync(full).mtimeMs < cutoffMs) { fs.unlinkSync(full); }
					} catch { /* ignore */ }
				}
			}
		} catch {
			// Best-effort; never throw out of startup path.
		}
	}

	/**
	 * W.30 — gzip files older than today. Plain `.jsonl` of today stays uncompressed
	 * (still being written); files from previous days get squeezed ~10x (text JSON is
	 * highly compressible). Compatible with readers via `.jsonl.gz` extension check.
	 */
	private _compressOldJsonl(): void {
		if (!this._config.compressOldJsonl) { return; }
		try {
			if (!fs.existsSync(this._logsDir)) { return; }
			const todayFile = path.basename(currentLogFile(this._logsDir));
			for (const file of fs.readdirSync(this._logsDir)) {
				if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) { continue; }
				if (file === todayFile) { continue; } // active file
				const srcPath = path.join(this._logsDir, file);
				const dstPath = `${srcPath}.gz`;
				if (fs.existsSync(dstPath)) { continue; } // already compressed (race-safe)
				try {
					const data = fs.readFileSync(srcPath);
					const compressed = zlib.gzipSync(data, { level: 9 });
					fs.writeFileSync(dstPath, compressed);
					fs.unlinkSync(srcPath);
				} catch {
					// Per-file failure shouldn't stop the rest.
				}
			}
		} catch {
			// Compression is best-effort; never throw.
		}
	}

	/**
	 * W.26 — enforce a total disk budget for `logs/vibe-idle-watchdog/`. Older
	 * snapshots → older `.jsonl.gz` → older `.jsonl` get pruned in that order
	 * until total size fits under `maxLogsTotalMB`. Defends against runaway disk
	 * usage if heap-snapshot trigger loops on a long-running incident.
	 */
	private _enforceLogSizeCap(): void {
		try {
			if (!fs.existsSync(this._logsDir)) { return; }
			const budgetBytes = this._config.maxLogsTotalMB * 1024 * 1024;
			interface FileInfo { full: string; size: number; mtime: number; kind: 'snapshot' | 'jsonl' | 'gz' | 'other' }
			const files: FileInfo[] = [];
			const visit = (dir: string): void => {
				if (!fs.existsSync(dir)) { return; }
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					const full = path.join(dir, entry.name);
					if (entry.isDirectory()) { visit(full); continue; }
					try {
						const st = fs.statSync(full);
						const kind: FileInfo['kind'] = entry.name.endsWith('.heapsnapshot') ? 'snapshot'
							: entry.name.endsWith('.jsonl.gz') ? 'gz'
								: entry.name.endsWith('.jsonl') ? 'jsonl'
									: 'other';
						files.push({ full, size: st.size, mtime: st.mtimeMs, kind });
					} catch { /* ignore */ }
				}
			};
			visit(this._logsDir);
			let total = files.reduce((s, f) => s + f.size, 0);
			if (total <= budgetBytes) { return; }
			// Prune priority: oldest snapshots first, then oldest .jsonl.gz, then
			// oldest .jsonl (never the today file).
			const todayFile = path.basename(currentLogFile(this._logsDir));
			const sorted = files
				.filter(f => path.basename(f.full) !== todayFile)
				.sort((a, b) => {
					const order = { snapshot: 0, gz: 1, jsonl: 2, other: 3 };
					if (order[a.kind] !== order[b.kind]) { return order[a.kind] - order[b.kind]; }
					return a.mtime - b.mtime;
				});
			for (const f of sorted) {
				if (total <= budgetBytes) { break; }
				try {
					fs.unlinkSync(f.full);
					total -= f.size;
				} catch { /* ignore */ }
			}
		} catch {
			// Best-effort.
		}
	}

	/**
	 * W.45 — persist a compact summary of internal state (`_lastTickTsByKey`,
	 * `_lastSnapshotByKey`) to disk every 15 minutes and on `stop()`. Loaded on
	 * next startup → cross-session correlation: pre-flight notification can
	 * reference the last-known sample timestamp even after IDE restart.
	 */
	private _schedulePersistState(): void {
		const handle: TimerHandle = setInterval(() => this._persistState(), 15 * 60 * 1000) as unknown as TimerHandle;
		this._statePersistTimer = handle;
		unrefTimer(handle);
	}

	private _persistState(): void {
		try {
			const statePath = path.join(this._logsDir, PERSISTED_STATE_FILE);
			if (!fs.existsSync(this._logsDir)) { fs.mkdirSync(this._logsDir, { recursive: true }); }
			const payload = {
				v: 1,
				savedAt: new Date().toISOString(),
				lastTickTsByKey: Object.fromEntries(this._lastTickTsByKey),
				lastSnapshotByKey: Object.fromEntries(this._lastSnapshotByKey),
			};
			fs.writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8');
		} catch {
			// Persistence is best-effort.
		}
	}

	private _loadPersistedState(): void {
		try {
			const statePath = path.join(this._logsDir, PERSISTED_STATE_FILE);
			if (!fs.existsSync(statePath)) { return; }
			const raw = fs.readFileSync(statePath, 'utf-8');
			const parsed = JSON.parse(raw) as { lastTickTsByKey?: Record<string, string>; lastSnapshotByKey?: Record<string, number> };
			if (parsed?.lastTickTsByKey) {
				for (const [k, v] of Object.entries(parsed.lastTickTsByKey)) {
					if (typeof k === 'string' && typeof v === 'string') { this._lastTickTsByKey.set(k, v); }
				}
			}
			if (parsed?.lastSnapshotByKey) {
				for (const [k, v] of Object.entries(parsed.lastSnapshotByKey)) {
					if (typeof k === 'string' && typeof v === 'number') { this._lastSnapshotByKey.set(k, v); }
				}
			}
		} catch {
			// Corrupt state — fall back to empty maps (graceful degradation).
		}
	}

	/**
	 * W.34/W.42 pre-OOM detector. Fires `onPreOomAlert` when:
	 *   `heapUsed / heapLimit > preOomHeapRatio`  (default 0.85)
	 * OR (`gcMajorCount > 5 in last interval` AND `slope > 10 MB/min`).
	 * One-shot per (proc, windowId, pid) per session, tracked in `_preOomNotified`.
	 */
	private _evaluatePreOom(sample: WatchdogSampleBase, currentSlopeMBPerMin: number): void {
		const k = keyFor({ proc: sample.proc, windowId: sample.windowId, pid: sample.pid });
		if (this._preOomNotified.has(k)) { return; }
		const ratio = (sample.heapUsed !== undefined && sample.heapLimit !== undefined && sample.heapLimit > 0)
			? sample.heapUsed / sample.heapLimit
			: undefined;
		const heuristicRatio = ratio !== undefined && ratio > this._config.preOomHeapRatio;
		const heuristicGc = (sample.gcMajorCount ?? 0) > 5 && currentSlopeMBPerMin > 10;
		// Commit-charge heuristic (renderer OOM 2026-05-30): a process can sit at a
		// healthy V8 heap ratio yet have committed gigabytes that the OS will eventually
		// refuse. `privateBytes` is only present on main-sampled children (incl. the
		// renderer commit-probe), so this branch is the sole pre-OOM signal for them.
		const commitMB = sample.privateBytes !== undefined ? sample.privateBytes / (1024 * 1024) : undefined;
		const heuristicCommit = this._config.commitAlertMB > 0
			&& commitMB !== undefined
			&& commitMB >= this._config.commitAlertMB;
		if (!heuristicRatio && !heuristicGc && !heuristicCommit) { return; }
		this._preOomNotified.add(k);
		const alert: WatchdogPreOomAlert = {
			proc: sample.proc,
			windowId: sample.windowId,
			pid: sample.pid,
			heapUsed: sample.heapUsed,
			heapLimit: sample.heapLimit,
			ratio,
			gcMajorCount: sample.gcMajorCount,
			ts: sample.ts,
		};
		this._onPreOomAlert.fire(alert);
		// W.46 opt-in graceful auto-restart. Schedules with 5-minute grace so the
		// user has time to react / save state if they're at the keyboard.
		if (this._config.autoRestartOnPreOom && sample.proc === 'main') {
			const restartHandle: TimerHandle = setTimeout(() => {
				try { app.relaunch(); app.exit(0); } catch { /* ignore */ }
			}, 5 * 60 * 1000) as unknown as TimerHandle;
			unrefTimer(restartHandle);
		}
	}

	/**
	 * Read tail of latest `.jsonl` (used by pre-flight «previous crashed» check — W.14).
	 * Returns up to `maxLines` parsed lines from the most recent file present.
	 */
	readRecentTail(maxLines = 50): WatchdogLine[] {
		try {
			if (!fs.existsSync(this._logsDir)) { return []; }
			const files = fs.readdirSync(this._logsDir)
				.filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
				.sort()
				.reverse();
			if (files.length === 0) { return []; }
			const latestPath = path.join(this._logsDir, files[0]);
			const text = fs.readFileSync(latestPath, 'utf-8');
			const lines = text.split('\n').filter(Boolean);
			const tail = lines.slice(-maxLines);
			const parsed: WatchdogLine[] = [];
			for (const ln of tail) {
				try {
					const obj = JSON.parse(ln) as WatchdogLine;
					parsed.push(obj);
				} catch { /* skip malformed lines */ }
			}
			return parsed;
		} catch {
			return [];
		}
	}
}

// -----------------------------------------------------------------------------
// Module-level singleton + backward-compat exports for `src/main.ts`
// -----------------------------------------------------------------------------

let _instance: VibeIdleWatchdogService | null = null;

/**
 * Start the idle watchdog. Idempotent — second call is a no-op while the first
 * instance is alive. Must be called from the main process AFTER
 * `app.setPath('userData', ...)` so `userDataPath` is authoritative.
 */
export function startVibeIdleWatchdog(userDataPath: string): VibeIdleWatchdogService | null {
	if (_instance !== null) { return _instance; }
	const svc = new VibeIdleWatchdogService(userDataPath);
	svc.start();
	_instance = svc;
	return svc;
}

/**
 * Stop the watchdog. Used in tests and clean shutdown.
 */
export function stopVibeIdleWatchdog(): void {
	if (_instance === null) { return; }
	_instance.stop();
	_instance = null;
}

/**
 * Access the live singleton instance — used by `vibeIdleWatchdogChannel.ts` to
 * route IPC samples and by `src/main.ts` for crash-correlation hooks.
 */
export function getVibeIdleWatchdog(): VibeIdleWatchdogService | null {
	return _instance;
}
