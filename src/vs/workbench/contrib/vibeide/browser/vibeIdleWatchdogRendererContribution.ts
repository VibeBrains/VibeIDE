/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Renderer-side Idle Watchdog (roadmap W.1).
 *
 * Closes the slate covered by the 2026-05-22/23 renderer-OOM incident:
 * the main-process watchdog showed `rss=208 MB` stable all night, while
 * Chromium killed the renderer at `23:56:06 reason='oom'`. Main was blind
 * to it. This contribution samples renderer memory locally and pushes via
 * IPC to the main-process write queue so all three process classes
 * (main + renderer + ext-host) appear in one `.jsonl` per day.
 *
 * The sample interval mirrors `vibeide.diagnostics.idleWatchdog.intervalMinutes`
 * via `IConfigurationService`; the live workbench has `IConfigurationService`
 * available, so renderer-side hot-reload happens naturally (no need for
 * settings.json `fs.watch` — main-side already has that for itself).
 *
 * Idle-time tracking (roadmap W.10) — listens to focus/blur and keystroke /
 * mouse events on the window (throttled), reports `idleSec`.
 *
 * @see common/vibeIdleWatchdogProxy.ts — IPC proxy.
 * @see electron-main/vibeIdleWatchdogService.ts — write queue.
 */

import { vibeLog } from '../common/vibeLog.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize } from '../../../../nls.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';
import type { WatchdogPreOomAlert, WatchdogSampleBase, WatchdogSlopeAlert } from '../common/vibeIdleWatchdogTypes.js';

const FIRST_TICK_DELAY_MS = 10_000;
const DEFAULT_INTERVAL_MINUTES = 5;
const CONFIG_KEY_ENABLED = 'vibeide.diagnostics.idleWatchdog.enabled';
const CONFIG_KEY_INTERVAL = 'vibeide.diagnostics.idleWatchdog.intervalMinutes';

interface ChromiumPerformanceMemory {
	readonly jsHeapSizeLimit: number;
	readonly totalJSHeapSize: number;
	readonly usedJSHeapSize: number;
}

function readPerformanceMemory(): ChromiumPerformanceMemory | undefined {
	const perf = (mainWindow as unknown as { performance?: { memory?: ChromiumPerformanceMemory } }).performance;
	return perf?.memory;
}

interface RendererGcMetrics { count: number; majorCount: number; totalMs: number }
interface RendererGcObserver { snapshot(): RendererGcMetrics; dispose(): void }

/**
 * W.9 — renderer-side GC pressure observer. Counts Chromium GC events between
 * watchdog ticks. Chromium's `performance.measureUserAgentSpecificMemory()` API
 * gives heap snapshots, but for cheap per-tick GC stats we tap `PerformanceObserver`
 * with the `'measure'` entry type set up for `'gc'` measurements (available in
 * Node — Chromium does NOT expose `'gc'` to the renderer JS). Falls back to no-op
 * when unavailable, in which case main-side `gcMajorCount` carries the signal.
 */
function attachRendererGcObserver(): RendererGcObserver | undefined {
	const PerfObs = (globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
	if (typeof PerfObs !== 'function') { return undefined; }
	// Skip when this Chromium build doesn't expose the 'gc' performance entry type.
	// `observe({ entryTypes: ['gc'] })` does NOT throw on an unsupported type — it
	// silently observes nothing AND makes Chrome print a non-interceptable console
	// warning ("The entry type 'gc' does not exist or isn't supported.") that bypasses
	// console.* (so it can never carry our datetime prefix). Gate on supportedEntryTypes.
	const supported = (PerfObs as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes;
	if (Array.isArray(supported) && !supported.includes('gc')) { return undefined; }
	try {
		const metrics: RendererGcMetrics = { count: 0, majorCount: 0, totalMs: 0 };
		const obs = new PerfObs((list) => {
			for (const entry of list.getEntries()) {
				if (entry.entryType !== 'gc') { continue; }
				metrics.count += 1;
				metrics.totalMs += entry.duration;
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

interface ProcessMemoryAccess {
	memoryUsage?: () => NodeJS.MemoryUsage;
	pid?: number;
	uptime?: () => number;
}

function readNodeProcess(): ProcessMemoryAccess | undefined {
	return (globalThis as unknown as { process?: ProcessMemoryAccess }).process;
}

function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) + h) + s.charCodeAt(i);
	}
	return (h >>> 0).toString(16);
}

/**
 * Renderer Idle Watchdog. One instance per renderer window.
 */
export class VibeIdleWatchdogRendererContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeIdleWatchdogRenderer';

	private readonly _windowId = (() => {
		// Stable per-window numeric id derived from full UUID via djb2.
		// Pre-W.22 took only the first 8 hex chars (~32 bits actual entropy) — for
		// 1000 windows opened in a session that's birthday-collision risk ~1%, and
		// log correlation would silently merge two different windows' samples.
		// Full UUID (128 bits) folded through djb2 to 32-bit unsigned ID: collision
		// probability with 1000 windows ≈ 1.2e-7 (effectively zero).
		const uuid = generateUuid().replace(/-/g, '');
		let h = 5381;
		for (let i = 0; i < uuid.length; i++) {
			h = (((h << 5) + h) + uuid.charCodeAt(i)) >>> 0;
		}
		return h;
	})();

	private readonly _intervalTimer = this._register(new MutableDisposable());
	private readonly _firstTickTimer = this._register(new MutableDisposable());
	private _lastActivityTs = Date.now();
	private _disposed = false;
	private _bootMs = Date.now();
	private _workspaceHash: string | undefined;
	private _gcObserver: RendererGcObserver | undefined;

	constructor(
		@IConfigurationService private readonly _configService: IConfigurationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IHostService private readonly _hostService: IHostService,
		@IVibeIdleWatchdogProxy private readonly _proxy: IVibeIdleWatchdogProxy,
		@INotificationService private readonly _notifications: INotificationService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		if (!this._isEnabled()) { return; }

		this._workspaceHash = this._computeWorkspaceHash();
		this._gcObserver = attachRendererGcObserver();
		this._installActivityListeners();
		this._scheduleFirstTick();
		this._scheduleInterval();
		this._register(this._configService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_KEY_ENABLED) || e.affectsConfiguration(CONFIG_KEY_INTERVAL)) {
				this._reschedule();
			}
		}));
		// W.27 — recompute workspaceHash when user adds/removes workspace folders.
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => {
			this._workspaceHash = this._computeWorkspaceHash();
		}));
		// W.5 — subscribe to main-side slope alerts.
		this._register(this._proxy.onSlopeAlert(alert => this._handleSlopeAlert(alert)));
		// W.42 — pre-OOM alerts (more urgent than slope). Same focused-window filter
		// to avoid N toasts in multi-window setups.
		this._register(this._proxy.onPreOomAlert(alert => this._handlePreOomAlert(alert)));
	}

	override dispose(): void {
		this._gcObserver?.dispose();
		this._disposed = true;
		super.dispose();
	}

	private _isEnabled(): boolean {
		return this._configService.getValue<boolean>(CONFIG_KEY_ENABLED) !== false;
	}

	private _intervalMs(): number {
		const raw = this._configService.getValue<number>(CONFIG_KEY_INTERVAL);
		const minutes = typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 && raw <= 60 ? raw : DEFAULT_INTERVAL_MINUTES;
		return minutes * 60 * 1000;
	}

	private _scheduleFirstTick(): void {
		const handle = setTimeout(() => this._tick('first-tick'), FIRST_TICK_DELAY_MS);
		this._firstTickTimer.value = { dispose: () => clearTimeout(handle) };
	}

	private _scheduleInterval(): void {
		const handle = mainWindow.setInterval(() => this._tick(), this._intervalMs());
		this._intervalTimer.value = { dispose: () => mainWindow.clearInterval(handle) };
	}

	private _reschedule(): void {
		this._intervalTimer.clear();
		if (this._isEnabled()) { this._scheduleInterval(); }
	}

	private _installActivityListeners(): void {
		const update = () => { this._lastActivityTs = Date.now(); };
		// Use capturing phase to count interactions before any UI handlers stopPropagation.
		mainWindow.addEventListener('keydown', update, { capture: true, passive: true });
		mainWindow.addEventListener('mousemove', update, { capture: true, passive: true });
		mainWindow.addEventListener('mousedown', update, { capture: true, passive: true });
		mainWindow.addEventListener('focus', update, { capture: true, passive: true });
		this._register({
			dispose: () => {
				mainWindow.removeEventListener('keydown', update, true);
				mainWindow.removeEventListener('mousemove', update, true);
				mainWindow.removeEventListener('mousedown', update, true);
				mainWindow.removeEventListener('focus', update, true);
			},
		});
	}

	private _computeWorkspaceHash(): string | undefined {
		const folders = this._workspace.getWorkspace().folders;
		if (folders.length === 0) { return undefined; }
		return djb2(folders.map(f => f.uri.toString()).join('|'));
	}

	private async _tick(note?: string): Promise<void> {
		if (this._disposed) { return; }
		try {
			const sample = this._buildSample(note);
			await this._proxy.appendSample(sample);
		} catch (e) {
			// Logging at warn level to keep the dev console quiet on transient IPC drops;
			// repeated failures will still show.
			vibeLog.warn('vibeIdleWatchdogRenderer', `[VibeIdleWatchdogRenderer] sample push failed: ${(e instanceof Error ? e.message : String(e))}`);
		}
	}

	private _handleSlopeAlert(alert: WatchdogSlopeAlert): void {
		// Commit-metric alerts are emitted from main without a windowId (main can't map
		// pid→window for the renderer commit-probe), so they can't be routed to one
		// renderer. Treat them like non-renderer alerts below: focus-gated, single window.
		const isCommit = alert.metric === 'commit';
		// Renderer-specific RSS alerts belong to a single window; skip if not ours.
		if (alert.proc === 'renderer' && !isCommit && alert.windowId !== undefined && alert.windowId !== this._windowId) { return; }
		// Non-renderer alerts (main, exthost, gpu, utility) AND commit-metric alerts can
		// fire on any window. To avoid N duplicate toasts in a multi-window setup, only
		// the focused window surfaces them. Edge case: no window focused — alert is
		// silently dropped on this side; the .jsonl still records growth for offline review.
		if ((alert.proc !== 'renderer' || isCommit) && !this._hostService.hasFocus) { return; }

		const procLabel = this._procLabel(alert.proc);
		this._notifications.notify({
			severity: Severity.Warning,
			message: isCommit
				? localize(
					'vibeide.watchdog.slopeAlertCommit',
					'VibeIDE: commit-память (private bytes) {0} растёт {1} МБ/мин (sustained over the last 12 samples). Рост идёт в выделенной памяти, а не в working set — в диспетчере задач он может быть незаметен. Возможна off-heap утечка (ArrayBuffers / нативные буферы); оставьте окно открытым и снимите crash report.',
					procLabel,
					alert.slopeMBPerMin.toFixed(1),
				)
				: localize(
					'vibeide.watchdog.slopeAlert',
					'VibeIDE: память {0} растёт {1} МБ/мин (sustained over the last 12 samples). Возможна утечка — оставьте окно открытым ещё на несколько минут и снимите crash report для анализа.',
					procLabel,
					alert.slopeMBPerMin.toFixed(1),
				),
			actions: {
				primary: [
					{
						id: 'vibeide.watchdog.slopeAlert.bundle',
						label: localize('vibeide.watchdog.slopeAlert.bundle', 'Собрать crash report'),
						tooltip: '',
						class: undefined,
						enabled: true,
						// Invoke the Action2 directly via ICommandService — same handler
						// as the Command Palette entry, so the bundle workflow is real
						// (pre-W.22 showed a stub «use Command Palette» toast which was
						// a no-op for the user already alerted in real time).
						run: () => this._commandService.executeCommand('vibeide.watchdog.bundleCrashReport'),
					},
					{
						id: 'vibeide.watchdog.slopeAlert.dismiss',
						label: localize('vibeide.watchdog.slopeAlert.dismiss', 'Пропустить'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => { /* no-op */ },
					},
				],
			},
		});
	}

	private _procLabel(proc: string): string {
		switch (proc) {
			case 'main': return 'main-процесса';
			case 'renderer': return 'окна редактора';
			case 'exthost': return 'extension host';
			case 'gpu': return 'GPU-процесса';
			case 'utility': return 'служебного процесса';
			default: return proc;
		}
	}

	private _buildSample(note?: string): WatchdogSampleBase {
		const now = Date.now();
		const idleSec = Math.max(0, Math.round((now - this._lastActivityTs) / 1000));
		const uptimeSec = Math.round((now - this._bootMs) / 1000);
		const nodeProc = readNodeProcess();
		const mem = nodeProc?.memoryUsage?.();
		const chromiumMem = readPerformanceMemory();
		const rss = mem?.rss ?? chromiumMem?.totalJSHeapSize ?? 0;
		const heapUsed = mem?.heapUsed ?? chromiumMem?.usedJSHeapSize ?? 0;
		const heapTotal = mem?.heapTotal ?? chromiumMem?.totalJSHeapSize ?? 0;
		// W.42 — V8 hard limit; from Chromium's `performance.memory.jsHeapSizeLimit`
		// (renderer always has this) or undefined if no source available.
		const heapLimit = chromiumMem?.jsHeapSizeLimit;
		const gc = this._gcObserver?.snapshot();
		const focused = this._hostService.hasFocus;
		const sample: WatchdogSampleBase = {
			v: 1,
			type: 'sample',
			ts: new Date(now).toISOString(),
			proc: 'renderer',
			pid: nodeProc?.pid ?? -1,
			uptimeSec,
			rss,
			heapUsed,
			heapTotal,
			heapLimit,
			external: mem?.external,
			arrayBuffers: mem?.arrayBuffers,
			windowId: this._windowId,
			workspaceHash: this._workspaceHash,
			idleSec: focused ? idleSec : undefined,
			gcCount: gc?.count,
			gcMajorCount: gc?.majorCount,
			gcTotalMs: gc?.totalMs,
			note,
		};
		return sample;
	}

	private _handlePreOomAlert(alert: WatchdogPreOomAlert): void {
		if (alert.proc === 'renderer' && alert.windowId !== undefined && alert.windowId !== this._windowId) { return; }
		if (alert.proc !== 'renderer' && !this._hostService.hasFocus) { return; }
		// W.17 — opt-in DevTools auto-open on pre-OOM. Helps user manually capture
		// heap snapshot in Chrome DevTools Memory panel before V8 aborts.
		if (this._configService.getValue<boolean>('vibeide.diagnostics.idleWatchdog.autoOpenDevToolsOnPreOom') === true
			&& alert.proc === 'renderer' && alert.windowId === this._windowId) {
			void this._commandService.executeCommand('workbench.action.toggleDevTools');
		}
		const procLabel = this._procLabel(alert.proc);
		const ratioStr = alert.ratio !== undefined ? (alert.ratio * 100).toFixed(0) + '%' : '?';
		this._notifications.notify({
			severity: Severity.Warning,
			message: localize(
				'vibeide.watchdog.preOomAlert',
				'VibeIDE: {0} в шаге от V8 OOM (heap used / limit = {1}). Рекомендуется собрать crash report и перезапустить окно до фатального сбоя.',
				procLabel,
				ratioStr,
			),
			actions: {
				primary: [
					{
						id: 'vibeide.watchdog.preOomAlert.snapshot',
						label: localize('vibeide.watchdog.preOomAlert.snapshot', 'Снять heap snapshot'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => this._proxy.triggerMainHeapSnapshot().then(() => undefined),
					},
					{
						id: 'vibeide.watchdog.preOomAlert.bundle',
						label: localize('vibeide.watchdog.preOomAlert.bundle', 'Собрать crash report'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => this._commandService.executeCommand('vibeide.watchdog.bundleCrashReport'),
					},
					{
						// D.8 — one-click recovery: a clean window reload frees the ballooning renderer
						// before V8/commit OOM aborts it (the message already recommends this).
						id: 'vibeide.watchdog.preOomAlert.reload',
						label: localize('vibeide.watchdog.preOomAlert.reload', 'Перезагрузить окно'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => this._commandService.executeCommand('workbench.action.reloadWindow'),
					},
					{
						id: 'vibeide.watchdog.preOomAlert.dismiss',
						label: localize('vibeide.watchdog.preOomAlert.dismiss', 'Пропустить'),
						tooltip: '',
						class: undefined,
						enabled: true,
						run: () => { /* no-op */ },
					},
				],
			},
		});
	}
}

registerWorkbenchContribution2(
	VibeIdleWatchdogRendererContribution.ID,
	VibeIdleWatchdogRendererContribution,
	WorkbenchPhase.Eventually,
);
