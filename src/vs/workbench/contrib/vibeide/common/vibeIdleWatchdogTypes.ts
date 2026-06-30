/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Idle Watchdog — shared types between main / renderer / extension host.
 *
 * All `.jsonl` lines in `${userDataPath}/logs/vibe-idle-watchdog/YYYY-MM-DD.jsonl`
 * conform to one of the union members below. Schema version `v` allows for
 * future migrations; readers must default-treat missing `v` as `1` and
 * missing `proc` as `'main'` (backward-compat for pre-W.0 lines).
 */

import type { Event } from '../../../../base/common/event.js';

export type WatchdogProc = 'main' | 'renderer' | 'exthost' | 'gpu' | 'utility';

export interface WatchdogSampleBase {
	readonly v: 1;
	readonly type: 'sample';
	readonly ts: string;
	readonly proc: WatchdogProc;
	readonly pid: number;
	readonly uptimeSec: number;
	readonly rss: number;
	/**
	 * V8 heap size. Always present for `main` and `renderer` samples (taken from
	 * `process.memoryUsage()` / `performance.memory`); intentionally absent for
	 * `exthost` / `gpu` / `utility` samples sourced from `app.getAppMetrics()`
	 * which exposes only RSS. Pre-W.22 versions emitted `0` here, which readers
	 * misinterpreted as «really zero». Treat `undefined` as «not measured».
	 */
	readonly heapUsed?: number;
	readonly heapTotal?: number;
	/**
	 * V8 hard upper bound for this process's JS heap (`performance.memory.jsHeapSizeLimit`
	 * in renderer; `--max-old-space-size` derived in node-side processes). Lets readers
	 * compute `heapUsed / heapLimit` ratio — the most accurate pre-V8-OOM signal (W.42).
	 */
	readonly heapLimit?: number;
	readonly external?: number;
	readonly arrayBuffers?: number;
	/**
	 * Private commit charge (a.k.a. private bytes) in BYTES — memory the process has
	 * committed and the OS counts against the system commit limit, NOT shared with
	 * other processes. Sourced from `app.getAppMetrics().memory.privateBytes` (main
	 * side only; reported in KB by Electron, stored here in bytes). This is the metric
	 * that catches commit-charge OOMs invisible in `rss` / working set: a renderer can
	 * commit gigabytes (ArrayBuffers, WASM, PartitionAlloc super-pages) while its working
	 * set stays small, then die with Chromium `0xE0000008` when a routine reservation is
	 * refused. `heapUsed`/`rss` showed ~340/400 MB right up to such a crash. Undefined =
	 * not measured (renderer self-samples via `performance.memory` cannot read it).
	 */
	readonly privateBytes?: number;
	readonly handles?: number;
	readonly activeRequests?: number;
	readonly windowId?: number;
	readonly workspaceHash?: string;
	readonly idleSec?: number;
	readonly gcCount?: number;
	readonly gcMajorCount?: number;
	readonly gcTotalMs?: number;
	/**
	 * Counter of in-flight network requests at sample time (renderer fetch + WS open,
	 * main HTTP utility-process requests). Helps disambiguate idle-leak from active
	 * retry-storm. Optional — present only when the producer can supply it (W.32).
	 */
	readonly networkInflight?: number;
	/** Open file descriptors / FS request count (W.32 disk-tracker subset). */
	readonly fsActive?: number;
	readonly note?: string;
	readonly report?: WatchdogProcessReportSubset;
	/**
	 * XML tool-format normalization hit-counters (main-process only) — cumulative per main lifetime.
	 * `getNormalizeCounters()` from xmlToolNormalize: which fallback layer (fullPath/invoke/jsonArray/
	 * safetyNet*…) carried load for the models used this session. Dev-diagnostic: lands in the exported
	 * watchdog bundle so problematic-model format issues are visible without a separate harvest/IPC.
	 */
	readonly xmlNormalize?: Readonly<Record<string, number>>;
}

/**
 * Compact subset of `process.report.getReport()` written every Nth tick when
 * `includeProcessReport` setting is enabled. Full report is 10-50 KB; we keep
 * the high-signal fields and discard the rest.
 */
export interface WatchdogProcessReportSubset {
	readonly osMachine?: string;
	readonly libuvActiveHandles?: number;
	readonly libuvHandleTypes?: Readonly<Record<string, number>>;
	readonly maxRss?: number;
	readonly nativeStackTop?: readonly string[];
}

export interface WatchdogCrashEntry {
	readonly v: 1;
	readonly type: 'crash' | 'exit';
	readonly ts: string;
	readonly proc: WatchdogProc;
	readonly pid?: number;
	readonly windowId?: number;
	readonly reason?: string;
	readonly exitCode?: number;
	readonly signal?: string;
	readonly lastTickRef?: string;
}

export interface WatchdogSnapshotEntry {
	readonly v: 1;
	readonly type: 'snapshot';
	readonly ts: string;
	readonly proc: WatchdogProc;
	readonly pid: number;
	readonly windowId?: number;
	readonly path: string;
	readonly sizeBytes: number;
	readonly trigger: 'threshold' | 'slope' | 'manual' | 'signal';
}

export type WatchdogLine = WatchdogSampleBase | WatchdogCrashEntry | WatchdogSnapshotEntry;

/**
 * IPC channel name registered by main process; renderer uses `IMainProcessService.getChannel(...)`
 * to obtain the proxy, then calls `appendSample` / `appendCrashEntry`. Keep in sync with
 * `electron-main/vibeIdleWatchdogChannel.ts` and `browser/vibeIdleWatchdogRendererContribution.ts`.
 */
export const VIBE_IDLE_WATCHDOG_CHANNEL = 'vibeide-channel-idleWatchdog';

export interface WatchdogBundleResult {
	readonly outputPath: string;
	readonly sizeBytes: number;
	readonly fileCount: number;
}

/**
 * Slope-detector signal pushed from main to renderer (roadmap W.5 wiring).
 *
 * One alert per (proc, windowId, pid) triple per session — the slope watcher
 * marks itself notified to avoid spamming the user when a process is in a long
 * memory-growth phase.
 */
export interface WatchdogSlopeAlert {
	readonly proc: WatchdogProc;
	readonly slopeMBPerMin: number;
	readonly windowId?: number;
	readonly pid?: number;
	readonly ts: string;
	/**
	 * Which memory metric grew: `'rss'` (working set — the original W.5 signal) or
	 * `'commit'` (private commit charge / `privateBytes`). Absent → treat as `'rss'`
	 * for backward-compat with pre-commit-slope lines. Commit-slope catches leaks the
	 * RSS signal misses (renderer OOM 2026-05-30: RSS flat ~400 MB, commit climbed to
	 * ~13 GB). UI uses this to word the toast correctly — a low working set in Task
	 * Manager is expected for a commit balloon and must not read as a contradiction.
	 */
	readonly metric?: 'rss' | 'commit';
}

/**
 * Pre-OOM warning (roadmap W.34, W.42, W.46) — emitted when a renderer's V8 heap
 * approaches `jsHeapSizeLimit` (`used/limit > 0.85`) or when GC pressure + slope
 * together indicate the process is in minutes-from-OOM territory. More urgent
 * than `WatchdogSlopeAlert`. Receivers (renderer / auto-restart handler) may
 * trigger heap snapshot, restart prompt, or — opt-in — graceful auto-restart.
 */
export interface WatchdogPreOomAlert {
	readonly proc: WatchdogProc;
	readonly windowId?: number;
	readonly pid?: number;
	readonly heapUsed?: number;
	readonly heapLimit?: number;
	readonly ratio?: number;
	readonly gcMajorCount?: number;
	readonly ts: string;
}

export interface WatchdogCurrentSnapshot {
	readonly capturedAt: string;
	readonly samples: readonly WatchdogSampleBase[];
}

/**
 * IPC contract surface exposed by main to renderer / ext-host.
 */
export interface IVibeIdleWatchdogChannelService {
	readonly _serviceBrand: undefined;

	/** Event fired by main when sustained memory growth crosses the configured threshold (W.5). */
	readonly onSlopeAlert: Event<WatchdogSlopeAlert>;

	/** Event fired when a process crosses the pre-OOM heuristic (W.34/W.42). */
	readonly onPreOomAlert: Event<WatchdogPreOomAlert>;

	appendSample(line: WatchdogSampleBase): Promise<void>;
	appendCrash(entry: WatchdogCrashEntry): Promise<void>;
	appendSnapshot(entry: WatchdogSnapshotEntry): Promise<void>;

	/** Read the tail of the most recent `.jsonl` (W.14 pre-flight). */
	readRecentTail(maxLines: number): Promise<readonly WatchdogLine[]>;

	/** Bundle a crash report ZIP into `destPath`. Returns metadata. (W.11) */
	bundleCrashReport(destPath: string): Promise<WatchdogBundleResult>;

	/** Snapshot of the live state of all tracked processes (W.7/W.28 timeline viewer, W.47 panel). */
	getCurrentSnapshot(): Promise<WatchdogCurrentSnapshot>;

	/** Trigger an immediate heap snapshot of the main process (W.31, W.36, W.47 power-user action). */
	triggerMainHeapSnapshot(): Promise<WatchdogSnapshotEntry | null>;
}
