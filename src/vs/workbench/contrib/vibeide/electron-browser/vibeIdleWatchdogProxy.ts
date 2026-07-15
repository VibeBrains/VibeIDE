/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Desktop implementation of `IVibeIdleWatchdogProxy` (contract lives in
 * `../common/vibeIdleWatchdogProxy.ts`, wire types in `../common/vibeIdleWatchdogTypes.ts`).
 *
 * Renderer / ext-host code does **not** write to disk directly — it constructs a sample object and
 * forwards it through this proxy. Main is the single writer to the `.jsonl`, which preserves the
 * «single producer, no race» invariant.
 *
 * Sits in `electron-browser/` because it reaches main via `IMainProcessService`, banned in
 * `common/**` and `browser/**` alike. Its six consumers (status bar, pre-flight, bundle/timeline/
 * diagnosis actions, renderer contribution) keep importing the decorator from `common/`, so none of
 * them had to change.
 *
 * Loaded from `vs/workbench/workbench.desktop.main.ts` — a browser-layer module cannot import
 * electron-browser.
 *
 * @see electron-main/vibeIdleWatchdogChannel.ts — receiver on the main side.
 */

import { Event } from '../../../../base/common/event.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';
import {
	IVibeIdleWatchdogChannelService,
	VIBE_IDLE_WATCHDOG_CHANNEL,
	WatchdogBundleResult,
	WatchdogCrashEntry,
	WatchdogCurrentSnapshot,
	WatchdogLine,
	WatchdogPreOomAlert,
	WatchdogSampleBase,
	WatchdogSlopeAlert,
	WatchdogSnapshotEntry,
} from '../common/vibeIdleWatchdogTypes.js';

export class VibeIdleWatchdogProxy implements IVibeIdleWatchdogProxy {
	declare readonly _serviceBrand: undefined;
	private readonly _proxy: IVibeIdleWatchdogChannelService;
	readonly onSlopeAlert: Event<WatchdogSlopeAlert>;
	readonly onPreOomAlert: Event<WatchdogPreOomAlert>;

	constructor(@IMainProcessService mainProcessService: IMainProcessService) {
		this._proxy = ProxyChannel.toService<IVibeIdleWatchdogChannelService>(
			mainProcessService.getChannel(VIBE_IDLE_WATCHDOG_CHANNEL),
		);
		this.onSlopeAlert = this._proxy.onSlopeAlert;
		this.onPreOomAlert = this._proxy.onPreOomAlert;
	}

	appendSample(line: WatchdogSampleBase): Promise<void> {
		return this._proxy.appendSample(line);
	}

	appendCrash(entry: WatchdogCrashEntry): Promise<void> {
		return this._proxy.appendCrash(entry);
	}

	appendSnapshot(entry: WatchdogSnapshotEntry): Promise<void> {
		return this._proxy.appendSnapshot(entry);
	}

	readRecentTail(maxLines: number): Promise<readonly WatchdogLine[]> {
		return this._proxy.readRecentTail(maxLines);
	}

	bundleCrashReport(destPath: string): Promise<WatchdogBundleResult> {
		return this._proxy.bundleCrashReport(destPath);
	}

	getCurrentSnapshot(): Promise<WatchdogCurrentSnapshot> {
		return this._proxy.getCurrentSnapshot();
	}

	triggerMainHeapSnapshot(): Promise<WatchdogSnapshotEntry | null> {
		return this._proxy.triggerMainHeapSnapshot();
	}
}

registerSingleton(IVibeIdleWatchdogProxy, VibeIdleWatchdogProxy, InstantiationType.Delayed);
