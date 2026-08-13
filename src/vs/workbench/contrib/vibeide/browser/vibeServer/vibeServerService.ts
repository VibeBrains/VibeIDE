/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Vibe Server orchestrator (renderer). Owns the active runtime, exposes lifecycle to the UI
 * (view pane, status bar, commands) and opens the preview either embedded (Simple Browser)
 * or in the external browser. The HTTP/reload server itself lives in main (see
 * electron-main/vibeServer/vibeServerMainService.ts).
 */

import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IVibeServerStarted, VibeServerRuntimeKind } from '../../common/vibeServer/vibeServerIpc.js';
import { VibeServerPreviewTarget } from './vibeServerConstants.js';
import { ViewportLabel } from '../../common/designReview/designSlopRules.js';
import { DesignScanResult } from './vibeBrowserManager.js';

// Реализация — `electron-browser/vibeServer/vibeServerService.ts`: класс держит `IMainProcessService`
// (два канала: vibeServer + vibeServerProcess), запрещённый и в `common/**`, и в `browser/**`.
// Контракт остаётся здесь — его берут четыре потребителя из `browser/vibeServer/`
// (статус-бар, contribution, QR, view pane).

export const IVibeServerService = createDecorator<IVibeServerService>('vibeServerService');

export interface IVibeServerStatus {
	readonly state: 'stopped' | 'starting' | 'running';
	readonly started?: IVibeServerStarted;
	readonly kind?: VibeServerRuntimeKind;
}

export interface IVibeServerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeStatus: Event<void>;
	readonly status: IVibeServerStatus;
	/** Starts the preview server on the workspace root (runtime chosen by setting/auto-detect). */
	start(): Promise<void>;
	/** Brings up the project's Docker environment (compose/Dockerfile) and previews it. */
	startEnvironment(): Promise<void>;
	/** Stops then starts again, preserving the chosen runtime (Static/Dev/Docker). */
	restart(): Promise<void>;
	/** Stops the running server. No-op when stopped. */
	stop(): Promise<void>;
	/** Number of console errors/warnings captured from the embedded preview (for status/badge). */
	problemCount(): number;
	/** Opens the preview at the server root; `target` overrides the configured default. */
	openPreview(target?: VibeServerPreviewTarget): Promise<void>;
	/** Opens an additional embedded preview tab (multi-preview). */
	openPreviewNewTab(): Promise<void>;
	/**
	 * Opens the preview at an arbitrary URL — a stack entry's own address, which is unrelated to
	 * the auto-detected single server behind `openPreview()`. Multi-app stacks have no "the" server.
	 * `title` names the tab when the per-service tab layout is on; honours
	 * `vibeide.vibeServer.previewTabs`.
	 */
	openPreviewUrl(url: string, title?: string, target?: VibeServerPreviewTarget): Promise<void>;
	/** Force-reloads all open embedded preview tabs. */
	reloadPreview(): void;
	/**
	 * Measures the previewed page for the design rules (passive: reads computed styles, changes
	 * nothing). Reports why it could not measure instead of returning an empty result — "nothing
	 * found" and "nothing measured" must not look alike.
	 */
	scanDesign(viewport?: ViewportLabel): Promise<DesignScanResult>;
	/**
	 * Frames the given findings on the previewed page and labels each with its rule id; an empty
	 * list clears the overlay. No-op when no preview is open.
	 */
	showDesignFindings(items: readonly { selector: string; rule: string; severity: string }[]): void;

	/**
	 * Снимок открытого превью картинкой в чат.
	 *
	 * Возвращает причину отказа словами, а не `false`: «нет превью» и «снимок не получился» —
	 * разные беды с разными действиями, и общий «не вышло» заставлял бы гадать.
	 */
	shotPreviewToChat(): Promise<{ ok: true } | { ok: false; reason: string }>;
	/** Starts the server if needed, then opens the preview at the given workspace file. */
	openPreviewForResource(resource: URI): Promise<void>;
	/** Copies the running server URL to the clipboard. */
	copyUrl(): Promise<void>;
	/** AI-loop: adds the preview's captured console errors as context for the next chat turn. */
	sendPreviewErrorsToChat(): Promise<void>;
	/** Copies the LAN URL (for previewing on a phone) to the clipboard. */
	showLanAddress(): Promise<void>;
	/** Returns the LAN URL (`http://<ip>:<port>/`) or undefined when unavailable. */
	getLanUrl(): Promise<string | undefined>;
}
