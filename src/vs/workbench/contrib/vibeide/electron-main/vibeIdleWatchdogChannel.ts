/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * IPC channel exposing the Idle Watchdog write-queue + slope-alert event to
 * renderer / ext-host (roadmap W.1, W.2, W.5).
 *
 * - **Samples push** (W.1/W.2): renderer-side contributions construct samples
 *   locally and `await proxy.appendSample(line)`. Main serialises all writes
 *   through its single `WriteQueue` so concurrent appends never race.
 * - **Slope alerts pull** (W.5): when main's slope-detector crosses the
 *   threshold, the channel emits `onSlopeAlert` to all listening renderers.
 *   Each renderer decides whether to surface a notification (typically
 *   filtered by `hostService.hasFocus` so only one window toasts).
 *
 * Channel name: `VIBE_IDLE_WATCHDOG_CHANNEL` (`vibeide-channel-idleWatchdog`).
 *
 * @see common/vibeIdleWatchdogTypes.ts — wire contract.
 * @see browser/vibeIdleWatchdogRendererContribution.ts — sample producer + slope subscriber.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import {
	IVibeIdleWatchdogChannelService,
	WatchdogBundleResult,
	WatchdogCrashEntry,
	WatchdogCurrentSnapshot,
	WatchdogLine,
	WatchdogPreOomAlert,
	WatchdogSampleBase,
	WatchdogSlopeAlert,
	WatchdogSnapshotEntry,
} from '../common/vibeIdleWatchdogTypes.js';
import { getVibeIdleWatchdog } from './vibeIdleWatchdogService.js';
import { bundleCrashReport } from './vibeIdleWatchdogBundler.js';

export class VibeIdleWatchdogChannelService extends Disposable implements IVibeIdleWatchdogChannelService {
	declare readonly _serviceBrand: undefined;

	private readonly _onSlopeAlert = this._register(new Emitter<WatchdogSlopeAlert>());
	readonly onSlopeAlert: Event<WatchdogSlopeAlert> = this._onSlopeAlert.event;

	private readonly _onPreOomAlert = this._register(new Emitter<WatchdogPreOomAlert>());
	readonly onPreOomAlert: Event<WatchdogPreOomAlert> = this._onPreOomAlert.event;

	constructor() {
		super();
		const svc = getVibeIdleWatchdog();
		if (svc !== null) {
			this._register(svc.onSlopeAlert(alert => {
				this._onSlopeAlert.fire({
					proc: alert.proc,
					slopeMBPerMin: alert.slopeMBPerMin,
					windowId: alert.windowId,
					pid: alert.pid,
					ts: new Date().toISOString(),
					metric: alert.metric,
				});
			}));
			this._register(svc.onPreOomAlert(alert => {
				this._onPreOomAlert.fire(alert);
			}));
		}
	}

	async getCurrentSnapshot(): Promise<WatchdogCurrentSnapshot> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) { return { capturedAt: new Date().toISOString(), samples: [] }; }
		return svc.getCurrentSnapshot();
	}

	async triggerMainHeapSnapshot(): Promise<WatchdogSnapshotEntry | null> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) { return null; }
		return svc.triggerMainHeapSnapshot();
	}

	async appendSample(line: WatchdogSampleBase): Promise<void> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) { return; }
		svc.acceptExternalSample(line);
	}

	async appendCrash(entry: WatchdogCrashEntry): Promise<void> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) { return; }
		svc.acceptExternalCrash(entry);
	}

	async appendSnapshot(entry: WatchdogSnapshotEntry): Promise<void> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) { return; }
		svc.acceptExternalSnapshot(entry);
	}

	async readRecentTail(maxLines: number): Promise<readonly WatchdogLine[]> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) { return []; }
		return svc.readRecentTail(maxLines);
	}

	async bundleCrashReport(destPath: string): Promise<WatchdogBundleResult> {
		const svc = getVibeIdleWatchdog();
		if (svc === null) {
			return { outputPath: destPath, sizeBytes: 0, fileCount: 0 };
		}
		return bundleCrashReport(svc.userDataPath, destPath);
	}
}
