/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { app } from 'electron';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import { IVibeWindowAttentionMain, VibeWindowAttentionRequest } from '../common/vibeWindowAttentionIpc.js';

/**
 * Main-process implementation behind `vibeide-channel-windowAttention`.
 *
 * Flashes the taskbar icon (Windows/Linux) via `BrowserWindow.flashFrame` — deliberately WITHOUT a
 * badge, unlike `FocusMode.Notify`. On Windows `flashFrame(true)` flashes until the window comes to
 * the foreground; a one-shot `focus` listener also clears it explicitly. On macOS there is no taskbar
 * flash, so the dock bounces instead (also badge-free).
 */
export class VibeWindowAttentionMainService extends Disposable implements IVibeWindowAttentionMain {

	/** Window ids with a pending focus-clear listener, so repeated flashes don't stack listeners. */
	private readonly _flashing = new Set<number>();

	constructor(
		private readonly _windowsMainService: IWindowsMainService,
		private readonly _log: ILogService,
	) {
		super();
	}

	async flashWindow(req: VibeWindowAttentionRequest): Promise<void> {
		try {
			if (isMacintosh) {
				app.dock?.bounce('informational');
				return;
			}

			const win = this._windowsMainService.getWindowById(req.windowId)?.win;
			if (!win || win.isDestroyed()) {
				return;
			}

			win.flashFrame(true);

			// flashFrame(true) flashes until focus on Windows; clear it explicitly on focus as well so a
			// stale highlight never lingers, and avoid stacking listeners across repeated flashes.
			if (!this._flashing.has(req.windowId)) {
				this._flashing.add(req.windowId);
				win.once('focus', () => {
					this._flashing.delete(req.windowId);
					try {
						if (!win.isDestroyed()) { win.flashFrame(false); }
					} catch { /* window gone */ }
				});
			}
		} catch (err) {
			this._log.warn(`[VibeWindowAttention] flashWindow failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}
