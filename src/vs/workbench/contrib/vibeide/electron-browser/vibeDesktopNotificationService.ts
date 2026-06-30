/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Desktop implementation of `IVibeDesktopNotificationService` (contract + config live in
 * `../browser/vibeDesktopNotificationService.ts`).
 *
 * Two attention signals fire together when the IDE is in the background:
 *  - Taskbar attention (`vibeide-channel-windowAttention` → `BrowserWindow.flashFrame`): flashes the
 *    taskbar icon on Windows/Linux / bounces the dock on macOS, WITHOUT a badge (the static dot that
 *    `FocusMode.Notify` adds via `app.setBadgeCount`). It does NOT steal focus and auto-clears when the
 *    window is focused. Clicking the taskbar icon natively switches to the window's virtual desktop and
 *    focuses it — the durable, activator-free way to "jump back to the IDE", which is why it is primary.
 *  - OS toast (`INativeHostService.showToast`, a main-process Electron Notification): shows the
 *    message; clicking the live banner jumps to the IDE immediately (`FocusMode.Force`). A persistent
 *    banner is intentionally NOT used — Windows silently drops reminder/persistent toasts without a
 *    registered ToastActivatorCLSID, so the transient toast plus the taskbar flash is the reliable mix.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { getActiveWindow } from '../../../../base/browser/dom.js';
import { FocusMode, INativeHostService, IToastResult } from '../../../../platform/native/common/native.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { validateDesktopNotification, DesktopNotificationSpec, NotificationPlatform } from '../common/desktopNotificationSpec.js';
import { IVibeWindowAttentionMain, VIBE_WINDOW_ATTENTION_CHANNEL } from '../common/vibeWindowAttentionIpc.js';
import { NotifySoundEvent } from '../browser/vibeNotifySoundService.js';
import { ApprovalEventType, DesktopApprovalNotification, IVibeDesktopNotificationService } from '../browser/vibeDesktopNotificationService.js';

// Anti-spam for state-transition toasts: mirrors the notification-sound debounce so a burst of
// transitions never produces a stack of toasts (local, self-evident — not a user-facing setting).
const EVENT_TOAST_MIN_INTERVAL_MS = 1500;

class VibeDesktopNotificationService extends Disposable implements IVibeDesktopNotificationService {
	declare readonly _serviceBrand: undefined;

	private readonly _lastFiredAt = new Map<ApprovalEventType, number>();
	private _lastEventToastAt = 0;
	private readonly _windowAttentionMain: IVibeWindowAttentionMain;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IHostService private readonly _hostService: IHostService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IMainProcessService mainProcessService: IMainProcessService,
	) {
		super();
		this._windowAttentionMain = ProxyChannel.toService<IVibeWindowAttentionMain>(mainProcessService.getChannel(VIBE_WINDOW_ATTENTION_CHANNEL));
	}

	notifyApprovalNeeded(notification: DesktopApprovalNotification): void {
		if (!this._config.getValue<boolean>('vibeide.notifications.desktopApprovals.enabled')) {
			return;
		}

		const enabledEvents = this._config.getValue<ApprovalEventType[]>('vibeide.notifications.desktopApprovals.events') ?? [];
		if (!enabledEvents.includes(notification.type)) {
			return;
		}

		const throttleMs = this._config.getValue<number>('vibeide.notifications.desktopApprovals.throttleMs') ?? 30000;
		const lastFired = this._lastFiredAt.get(notification.type) ?? 0;
		const now = Date.now();

		if (!notification.urgent && now - lastFired < throttleMs) {
			this._log.trace(`[VibeDesktopNotif] Throttled ${notification.type} (${now - lastFired}ms since last)`);
			return;
		}

		this._lastFiredAt.set(notification.type, now);
		this._log.info(`[VibeDesktopNotif] Firing approval notification: type=${notification.type} urgent=${notification.urgent}`);

		const draft = { title: notification.title, body: notification.body, urgency: notification.urgent ? 'critical' as const : 'normal' as const };
		const validation = validateDesktopNotification(draft, this._getPlatform());
		if (!validation.ok) {
			this._log.warn(`[VibeDesktopNotif] Spec validation failed: ${validation.issues.join(', ')} — falling back to in-IDE toast`);
			this._notifications.notify({ severity: Severity.Info, message: `${notification.title}\n${notification.body}` });
			return;
		}

		// In front → in-IDE toast only. In background → flash the taskbar (durable) + a transient OS
		// toast; fall back to the in-IDE toast when the platform has no notification support or IPC fails.
		const windowFocused = getActiveWindow().document.hasFocus();
		const inIdeFallback = () => this._notifications.notify({
			severity: notification.urgent ? Severity.Warning : Severity.Info,
			message: `${notification.title}\n${notification.body}`,
		});

		if (windowFocused) {
			inIdeFallback();
			return;
		}

		this._flashAttention();
		this._showOsToast(notification.type, validation.spec).then(supported => {
			if (!supported) { inIdeFallback(); }
		}, () => inIdeFallback());
	}

	notifyForEvent(event: NotifySoundEvent): void {
		if (this._config.getValue<boolean>('vibeide.notify.desktop.enabled') === false) {
			return;
		}

		// A toast — and the taskbar flash it accompanies — only makes sense when the IDE is in the
		// background. When it's focused the user is already here, so stay silent (matches the sound gate).
		if (this._hostService.hasFocus) {
			return;
		}

		const now = Date.now();
		if (now - this._lastEventToastAt < EVENT_TOAST_MIN_INTERVAL_MS) {
			return;
		}
		this._lastEventToastAt = now;

		// Durable attention first: it works even if the OS toast doesn't show.
		this._flashAttention();

		const { title, body } = this._textForEvent(event);
		const validation = validateDesktopNotification({ title, body, urgency: 'normal' }, this._getPlatform());
		if (!validation.ok) {
			this._log.warn(`[VibeDesktopNotif] Event toast spec validation failed: ${validation.issues.join(', ')}`);
			return;
		}

		// No in-IDE fallback here: the IDE is unfocused (we just checked), so an in-app toast would go
		// unseen. If the platform has no notification support we simply skip — the flash + sound remain.
		void this._showOsToast(`event|${event}`, validation.spec);
		this._log.trace(`[VibeDesktopNotif] Event toast requested for event=${event}`);
	}

	dismissForType(type: ApprovalEventType): void {
		void this._nativeHostService.clearToast(type);
		this._log.trace(`[VibeDesktopNotif] Dismissed type=${type}`);
	}

	/**
	 * Flash the taskbar icon (Windows/Linux) / bounce the dock (macOS) to signal background activity.
	 * Routed through the main process so it flashes WITHOUT a badge (the static dot that FocusMode.Notify
	 * adds via app.setBadgeCount). Does not steal focus; auto-clears when the window is focused, and
	 * clicking the taskbar icon natively switches to the window's virtual desktop and focuses it.
	 */
	private _flashAttention(): void {
		this._windowAttentionMain.flashWindow({ windowId: this._nativeHostService.windowId })
			.catch(err => this._log.warn(`[VibeDesktopNotif] taskbar attention failed: ${err}`));
	}

	/**
	 * Show a transient main-process OS toast and focus the IDE when its live banner is clicked.
	 * Reusing a stable `id` per kind makes a newer toast replace the older one (no stacking).
	 * Resolves whether the platform showed a toast, so callers can fall back to an in-IDE toast.
	 */
	private async _showOsToast(id: string, spec: DesktopNotificationSpec): Promise<boolean> {
		const result: IToastResult = await this._nativeHostService.showToast({ id, title: spec.title, body: spec.body, silent: spec.silent });
		if (result.clicked) {
			this._focusIde();
		}
		return result.supported;
	}

	/**
	 * Bring the IDE to the foreground on toast click. FocusMode.Force routes to the main process
	 * (app.focus({ steal: true }) on macOS) so the OS switches to the desktop/Space where the window
	 * already lives and focuses it there — the window is NOT moved between desktops.
	 */
	private _focusIde(): void {
		this._hostService.focus(mainWindow, { mode: FocusMode.Force })
			.catch(err => this._log.warn(`[VibeDesktopNotif] focus on toast click failed: ${err}`));
	}

	private _textForEvent(event: NotifySoundEvent): { title: string; body: string } {
		switch (event) {
			case 'awaiting_user':
				return {
					title: localize('vibeide.notify.desktop.awaitingUser.title', 'VibeIDE — нужен ваш ответ'),
					body: localize('vibeide.notify.desktop.awaitingUser.body', 'Агент ждёт вашего решения.'),
				};
			case 'stalled':
				return {
					title: localize('vibeide.notify.desktop.stalled.title', 'VibeIDE — работа приостановлена'),
					body: localize('vibeide.notify.desktop.stalled.body', 'Агент остановился и ждёт «Продолжить».'),
				};
			case 'complete':
			default:
				return {
					title: localize('vibeide.notify.desktop.complete.title', 'VibeIDE — задача завершена'),
					body: localize('vibeide.notify.desktop.complete.body', 'Агент закончил работу.'),
				};
		}
	}

	private _getPlatform(): NotificationPlatform {
		if (typeof process !== 'undefined' && typeof process.platform === 'string') {
			const p = process.platform;
			if (p === 'win32' || p === 'darwin' || p === 'linux') { return p; }
		}
		return 'unknown';
	}
}

registerSingleton(IVibeDesktopNotificationService, VibeDesktopNotificationService, InstantiationType.Delayed);
