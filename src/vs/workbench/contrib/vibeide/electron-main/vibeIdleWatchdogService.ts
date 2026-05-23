/*--------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------*/

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
 *
 * Settings hot-reload (W.8): `fs.watch` on `User/settings.json` re-reads on change.
 *
 * @see docs/knowledge/runtime-quirks/idle-memory.md
 * @see docs/roadmap.md (section W)
 */

import * as path from 'node:path';
import * as fs from 'original-fs';
import * as v8 from 'node:v8';
import * as zlib from 'node:zlib';
import { PerformanceObserver } from 'node:perf_hooks';
import { app } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { parse as parseJsonc } from '../../../../base/common/jsonc.js';

// `setTimeout` / `setInterval` in Electron-main return native NodeJS.Timeout, but
// VS Code re-types `setTimeout` as returning `TimeoutHandle` (no `.unref`). The
// runtime handle DOES support `.unref()`. We use a feature-detection cast (same
// pattern as `electron-main/modelQuirks/modelQuirksService.ts:171,176`).
type TimerHandle = ReturnType<typeof setTimeout>;
function unrefTimer(handle: TimerHandle | null): void {
	const h = handle as unknown as { unref?: () => void };
	if (typeof h?.unref === 'function') h.unref();
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
	maxSnapshotsRetained: 3,
	includeChildProcessTypes: DEFAULT_CHILD_PROCESS_TYPES,
	maxLogsTotalMB: 500,
	preOomHeapRatio: 0.85,
	autoRestartOnPreOom: false,
	compressOldJsonl: true,
	adaptiveSampling: false,
	statisticalOutlier: false,
};

const ADAPTIVE_IDLE_THRESHOLD_SEC = 3600;
const ADAPTIVE_RATE_MULTIPLIER = 6;
const PERSISTED_STATE_FILE = 'state.json';

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.round(n)));
}

function clampBool(v: unknown, fallback: boolean): boolean {
	return typeof v === 'boolean' ? v : fallback;
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === 'number' ? v : Number(v);
	if (!Number.isFinite(n)) return fallback;
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
			maxSnapshotsRetained: clampInt(parsed['vibeide.diagnostics.idleWatchdog.maxSnapshotsRetained'], 1, 20, DEFAULTS.maxSnapshotsRetained),
			includeChildProcessTypes: childTypes,
			maxLogsTotalMB: clampInt(parsed['vibeide.diagnostics.idleWatchdog.maxLogsTotalMB'], 50, 10000, DEFAULTS.maxLogsTotalMB),
			preOomHeapRatio: clampFloat(parsed['vibeide.diagnostics.idleWatchdog.preOomHeapRatio'], 0.5, 0.99, DEFAULTS.preOomHeapRatio),
			autoRestartOnPreOom: clampBool(parsed['vibeide.diagnostics.idleWatchdog.autoRestartOnPreOom'], DEFAULTS.autoRestartOnPreOom),
			compressOldJsonl: clampBool(parsed['vibeide.diagnostics.idleWatchdog.compressOldJsonl'], DEFAULTS.compressOldJsonl),
			adaptiveSampling: clampBool(parsed['vibeide.diagnostics.idleWatchdog.adaptiveSampling'], DEFAULTS.adaptiveSampling),
			statisticalOutlier: clampBool(parsed['vibeide.diagnostics.idleWatchdog.statisticalOutlier'], DEFAULTS.statisticalOutlier),
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
	if (typeof getReport !== 'function') return undefined;
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
		if (dtMin <= 0) return { slopeMBPerMin: 0, samples: this._samples.length, outlier: false };
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
}

interface GcMetrics {
	count: number;
	majorCount: number;
	totalMs: number;
}

function attachGcObserver(): { snapshot: () => GcMetrics; dispose: () => void } | undefined {
	if (typeof PerformanceObserver !== 'function') return undefined;
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
				if (detail && (detail.kind === 2 || detail.kind === 15)) metrics.majorCount += 1;
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

	constructor(private readonly _resolveFile: () => string) {}

	enqueue(jsonLine: string): void {
		if (this._disposed) return;
		this._queue.push(jsonLine);
		void this._drain();
	}

	private async _drain(): Promise<void> {
		if (this._flushing) return;
		this._flushing = true;
		try {
			while (this._queue.length > 0 && !this._disposed) {
				const batch = this._queue.splice(0).join('');
				const filePath = this._resolveFile();
				try {
					const dir = path.dirname(filePath);
					if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
		if (this._disposed) return;
		if (this._queue.length > 0) {
			const finalBatch = this._queue.join('');
			this._queue = [];
			const filePath = this._resolveFile();
			try {
				const dir = path.dirname(filePath);
				if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
	private readonly _lastSnapshotByKey = new Map<string, number>();

	/**
	 * Slope-alert event. Multi-subscriber via standard `Emitter` — no longer the
	 * pre-W.22 single-callback `setSlopeNotifier`. Fires at most once per
	 * (proc, windowId, pid) per session (gated by `SlopeWatcher.markNotified`).
	 */
	private readonly _onSlopeAlert = new Emitter<{ proc: WatchdogProc; slopeMBPerMin: number; windowId?: number; pid?: number }>();
	readonly onSlopeAlert: Event<{ proc: WatchdogProc; slopeMBPerMin: number; windowId?: number; pid?: number }> = this._onSlopeAlert.event;

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
		if (!this._config.enabled) return;
		this._cleanupOldLogs();
		this._compressOldJsonl();
		this._enforceLogSizeCap();
		this._scheduleFirstTick();
		this._scheduleInterval();
		this._scheduleMidnightRotation();
		this._watchSettings();
		this._schedulePersistState();
		this._installSignalHandler();
	}

	/**
	 * W.19 — `kill -USR2 <pid>` triggers an out-of-band heap snapshot. Useful for
	 * remote / headless diagnostics on Linux + macOS where Command Palette is
	 * unavailable. Windows has no native SIGUSR2; harmless no-op there.
	 */
	private _installSignalHandler(): void {
		if (process.platform === 'win32') return;
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
			if (pidStr === 'x') continue;
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
			if (!fs.existsSync(this._snapshotsDir)) fs.mkdirSync(this._snapshotsDir, { recursive: true });
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

	private _scheduleFirstTick(): void {
		// 10s after startup — matches pre-W.0 behaviour. Captures baseline before
		// user interaction inflates working set.
		this._firstTickTimer = setTimeout(() => this._tickMain('first-tick'), 10_000) as unknown as TimerHandle;
		unrefTimer(this._firstTickTimer);
	}

	private _scheduleInterval(): void {
		const intervalMs = this._effectiveIntervalMs();
		this._intervalTimer = setInterval(() => this._tickMain(), intervalMs) as unknown as TimerHandle;
		unrefTimer(this._intervalTimer);
	}

	/**
	 * W.50 — when adaptive sampling is on AND no user activity for >1 hour, stretch
	 * the interval by 6×. Re-armed on the next tick if user is active again (the
	 * timer itself re-evaluates via `_maybeReschedule()` after each fire).
	 */
	private _effectiveIntervalMs(): number {
		const baseMs = this._config.intervalMinutes * 60 * 1000;
		if (!this._config.adaptiveSampling) return baseMs;
		const idleSec = (Date.now() - this._lastActivityTs) / 1000;
		return idleSec > ADAPTIVE_IDLE_THRESHOLD_SEC ? baseMs * ADAPTIVE_RATE_MULTIPLIER : baseMs;
	}

	/**
	 * After each tick, if adaptive sampling is on, check whether the effective
	 * interval should change (idle→active or active→idle transition) and
	 * re-arm the timer accordingly. Cheap: only fires when the boundary is
	 * crossed (compared to the active timer's period).
	 */
	private _maybeReschedule(): void {
		if (!this._config.adaptiveSampling) return;
		if (this._intervalTimer === null) return;
		const targetMs = this._effectiveIntervalMs();
		// We can't introspect setInterval's period; cheap heuristic: re-arm whenever
		// adaptive mode is on AND we just transitioned a boundary (track via a
		// simple flag).
		const wasStretched = (this._intervalTimer as unknown as { _vibeStretched?: boolean })._vibeStretched ?? false;
		const isStretched = targetMs > this._config.intervalMinutes * 60 * 1000;
		if (wasStretched !== isStretched) {
			this._clearTimer('_intervalTimer');
			this._scheduleInterval();
			if (this._intervalTimer) {
				(this._intervalTimer as unknown as { _vibeStretched?: boolean })._vibeStretched = isStretched;
			}
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
			if (!fs.existsSync(settingsPath)) return;
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
			if (next.enabled) this._scheduleInterval();
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
		const t = this[key];
		if (t !== null) {
			if (key === '_intervalTimer') clearInterval(t);
			else clearTimeout(t);
			this[key] = null;
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
			// W.50 — adjust sampling rate if idle/active state flipped.
			this._maybeReschedule();
			// W.26 — periodic budget check (cheap; just sums sizes once per tick).
			if (this._tickCounter % 12 === 0) this._enforceLogSizeCap();
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
			if (m.pid === process.pid) continue;             // main — already sampled
			if (m.type === 'Tab') continue;                   // renderer — covered by W.1
			if (!includeTypes.includes(m.type)) continue;     // user-configurable filter (W.22)
			const proc = mapElectronTypeToProc(m.type);
			// `workingSetSize` is in KILOBYTES per Electron docs; multiply to bytes for
			// schema consistency with `process.memoryUsage().rss`.
			const rss = (m.memory?.workingSetSize ?? 0) * 1024;
			const uptimeSec = m.creationTime ? Math.round((Date.now() - m.creationTime) / 1000) : 0;
			const sample: WatchdogSampleBase = {
				v: 1,
				type: 'sample',
				ts: tsString,
				proc,
				pid: m.pid,
				uptimeSec,
				rss,
				// `heapUsed` / `heapTotal` intentionally omitted — `app.getAppMetrics()`
				// does not expose V8 heap of children. Pre-W.22 emitted `0` here, which
				// readers misinterpreted as «really zero»; undefined = «not measured».
				note: this._composeChildNote(note, m.serviceName, m.name),
			};
			this._lastTickTsByKey.set(keyFor({ proc, pid: m.pid }), sample.ts);
			this._writeQueue.enqueue(JSON.stringify(sample) + '\n');
			this._evaluateSlope(sample);
			// Heap snapshot trigger only fires for `proc === 'main'` in `_maybeTriggerSnapshot`;
			// children would need CDP attach (deferred — see roadmap W.4 renderer-side note).
		}
		this._reconcileLiveProcesses(livePids);
	}

	private _composeChildNote(tickNote: string | undefined, serviceName?: string, name?: string): string | undefined {
		// Sanitise: strip newlines / control chars that would corrupt `.jsonl` lines
		// and trim semicolons (used as separator between tickNote and label).
		const sanitize = (s: string | undefined): string | undefined => s?.replace(/[\r\n\t]/g, ' ').replace(/;+/g, ',').trim() || undefined;
		const cleanTick = sanitize(tickNote);
		const cleanLabel = sanitize(serviceName) ?? sanitize(name);
		if (cleanTick && cleanLabel) return `${cleanTick}; ${cleanLabel}`;
		return cleanTick ?? cleanLabel ?? undefined;
	}

	private _buildMainSample(note?: string): WatchdogSampleBase {
		const mem = process.memoryUsage();
		const heapStats = v8.getHeapStatistics();
		const { handles, activeRequests } = readNodeHandleCount();
		const gc = this._gcObserver?.snapshot();
		// Include process.report every 10th tick when enabled — keeps file size reasonable.
		const includeReport = this._config.includeProcessReport && (this._tickCounter % 10 === 0);
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
			note,
			report: includeReport ? buildProcessReportSubset() : undefined,
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
		if (!watcher.notified && trigger) {
			watcher.markNotified();
			this._onSlopeAlert.fire({
				proc: sample.proc,
				slopeMBPerMin,
				windowId: sample.windowId,
				pid: sample.pid,
			});
		}
		// W.34/W.42 pre-OOM evaluation — orthogonal to slope alert, may fire on
		// the same sample if the heap ratio crosses threshold.
		this._evaluatePreOom(sample, slopeMBPerMin);
	}

	private _maybeTriggerSnapshot(sample: WatchdogSampleBase): void {
		if (!this._config.heapSnapshotOnHighRss) return;
		const rssMB = sample.rss / (1024 * 1024);
		if (rssMB < this._config.heapSnapshotThresholdMB) return;
		const k = keyFor({ proc: sample.proc, windowId: sample.windowId, pid: sample.pid });
		const last = this._lastSnapshotByKey.get(k) ?? 0;
		const cooldownMs = this._config.snapshotCooldownMinutes * 60 * 1000;
		const now = Date.now();
		if (now - last < cooldownMs) return;
		this._lastSnapshotByKey.set(k, now);
		// Only main can snapshot itself synchronously; renderer/exthost snapshots
		// are triggered by their own contributions (see W.4 in roadmap).
		if (sample.proc === 'main') {
			this.captureMainHeapSnapshot('threshold');
		}
	}

	private _rotateSnapshots(): void {
		try {
			if (!fs.existsSync(this._snapshotsDir)) return;
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
			if (!fs.existsSync(this._logsDir)) return;
			const cutoffMs = Date.now() - this._config.retentionDays * 24 * 60 * 60 * 1000;
			for (const file of fs.readdirSync(this._logsDir)) {
				const m = file.match(/^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
				if (!m) continue;
				const fileDateMs = Date.parse(`${m[1]}T00:00:00.000Z`);
				if (!Number.isFinite(fileDateMs)) continue;
				if (fileDateMs < cutoffMs) {
					try { fs.unlinkSync(path.join(this._logsDir, file)); } catch { /* ignore */ }
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
		if (!this._config.compressOldJsonl) return;
		try {
			if (!fs.existsSync(this._logsDir)) return;
			const todayFile = path.basename(currentLogFile(this._logsDir));
			for (const file of fs.readdirSync(this._logsDir)) {
				if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
				if (file === todayFile) continue; // active file
				const srcPath = path.join(this._logsDir, file);
				const dstPath = `${srcPath}.gz`;
				if (fs.existsSync(dstPath)) continue; // already compressed (race-safe)
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
			if (!fs.existsSync(this._logsDir)) return;
			const budgetBytes = this._config.maxLogsTotalMB * 1024 * 1024;
			interface FileInfo { full: string; size: number; mtime: number; kind: 'snapshot' | 'jsonl' | 'gz' | 'other' }
			const files: FileInfo[] = [];
			const visit = (dir: string): void => {
				if (!fs.existsSync(dir)) return;
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
			if (total <= budgetBytes) return;
			// Prune priority: oldest snapshots first, then oldest .jsonl.gz, then
			// oldest .jsonl (never the today file).
			const todayFile = path.basename(currentLogFile(this._logsDir));
			const sorted = files
				.filter(f => path.basename(f.full) !== todayFile)
				.sort((a, b) => {
					const order = { snapshot: 0, gz: 1, jsonl: 2, other: 3 };
					if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
					return a.mtime - b.mtime;
				});
			for (const f of sorted) {
				if (total <= budgetBytes) break;
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
			if (!fs.existsSync(this._logsDir)) fs.mkdirSync(this._logsDir, { recursive: true });
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
			if (!fs.existsSync(statePath)) return;
			const raw = fs.readFileSync(statePath, 'utf-8');
			const parsed = JSON.parse(raw) as { lastTickTsByKey?: Record<string, string>; lastSnapshotByKey?: Record<string, number> };
			if (parsed?.lastTickTsByKey) {
				for (const [k, v] of Object.entries(parsed.lastTickTsByKey)) {
					if (typeof k === 'string' && typeof v === 'string') this._lastTickTsByKey.set(k, v);
				}
			}
			if (parsed?.lastSnapshotByKey) {
				for (const [k, v] of Object.entries(parsed.lastSnapshotByKey)) {
					if (typeof k === 'string' && typeof v === 'number') this._lastSnapshotByKey.set(k, v);
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
		if (this._preOomNotified.has(k)) return;
		const ratio = (sample.heapUsed !== undefined && sample.heapLimit !== undefined && sample.heapLimit > 0)
			? sample.heapUsed / sample.heapLimit
			: undefined;
		const heuristicRatio = ratio !== undefined && ratio > this._config.preOomHeapRatio;
		const heuristicGc = (sample.gcMajorCount ?? 0) > 5 && currentSlopeMBPerMin > 10;
		if (!heuristicRatio && !heuristicGc) return;
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
			if (!fs.existsSync(this._logsDir)) return [];
			const files = fs.readdirSync(this._logsDir)
				.filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
				.sort()
				.reverse();
			if (files.length === 0) return [];
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
	if (_instance !== null) return _instance;
	const svc = new VibeIdleWatchdogService(userDataPath);
	svc.start();
	_instance = svc;
	return svc;
}

/**
 * Stop the watchdog. Used in tests and clean shutdown.
 */
export function stopVibeIdleWatchdog(): void {
	if (_instance === null) return;
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
