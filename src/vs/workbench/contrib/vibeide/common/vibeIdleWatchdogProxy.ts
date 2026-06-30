/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Workbench-layer proxy to the main-process Idle Watchdog channel.
 *
 * Renderer / ext-host code does **not** write to disk directly — it constructs
 * a sample object and forwards via this proxy. Main is the single writer to the
 * `.jsonl`, preserving the «single producer, no race» invariant.
 *
 * @see common/vibeIdleWatchdogTypes.ts — wire contract.
 * @see electron-main/vibeIdleWatchdogChannel.ts — receiver.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { Event } from '../../../../base/common/event.js';
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
} from './vibeIdleWatchdogTypes.js';

export interface IVibeIdleWatchdogProxy {
	readonly _serviceBrand: undefined;
	readonly onSlopeAlert: Event<WatchdogSlopeAlert>;
	readonly onPreOomAlert: Event<WatchdogPreOomAlert>;
	appendSample(line: WatchdogSampleBase): Promise<void>;
	appendCrash(entry: WatchdogCrashEntry): Promise<void>;
	appendSnapshot(entry: WatchdogSnapshotEntry): Promise<void>;
	readRecentTail(maxLines: number): Promise<readonly WatchdogLine[]>;
	bundleCrashReport(destPath: string): Promise<WatchdogBundleResult>;
	getCurrentSnapshot(): Promise<WatchdogCurrentSnapshot>;
	triggerMainHeapSnapshot(): Promise<WatchdogSnapshotEntry | null>;
}

export const IVibeIdleWatchdogProxy =
	createDecorator<IVibeIdleWatchdogProxy>('vibeIdleWatchdogProxy');

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
