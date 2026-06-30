/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * IPC contract for "flash the window to get attention" without the dock/taskbar badge.
 *
 * `IHostService.focus(FocusMode.Notify)` is the obvious path but it always acquires a badge
 * (`app.setBadgeCount` → a static dot overlay on the taskbar icon on Windows). We want just the
 * flashing icon (like other native apps), so this channel calls `BrowserWindow.flashFrame` directly
 * in the main process — no badge.
 */

export const VIBE_WINDOW_ATTENTION_CHANNEL = 'vibeide-channel-windowAttention';

export interface VibeWindowAttentionRequest {
	/** The renderer's own window id — the window to flash / bounce. */
	readonly windowId: number;
}

export interface IVibeWindowAttentionMain {
	/**
	 * Flash the taskbar icon (Windows/Linux) or bounce the dock (macOS) to signal background activity,
	 * without setting a badge. The flash auto-clears when the window is focused.
	 */
	flashWindow(req: VibeWindowAttentionRequest): Promise<void>;
}
