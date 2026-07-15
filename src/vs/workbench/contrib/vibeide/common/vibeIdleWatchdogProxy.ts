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
import { Event } from '../../../../base/common/event.js';
import {
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

// Реализация — `electron-browser/vibeIdleWatchdogProxy.ts`: она держит `IMainProcessService`,
// запрещённый и в `common/**`, и в `browser/**`. Здесь только контракт — шесть потребителей
// (статус-бар, pre-flight, bundle/timeline/diagnosis-действия, renderer-контрибуция) берут
// декоратор отсюда и от desktop-слоя не зависят.
