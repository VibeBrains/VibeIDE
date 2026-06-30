/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeDesktopNotificationService — contract + configuration (browser-layer, web-safe).
 *
 * This file holds only the decorator, the public interface, the payload types and the
 * configuration schema — nothing electron-specific — so it can be imported from the browser
 * layer and a future web build alike. The desktop implementation (which needs the main-process
 * Notification API) lives in `../electron-browser/vibeDesktopNotificationService.ts` and is
 * registered from the desktop entrypoint. A web build would register its own browser-layer
 * implementation against the same decorator.
 *
 * Behaviour (desktop impl): fires an OS toast when the IDE is in the background — for blocking
 * agent approvals (`notifyApprovalNeeded`) and for chat thread state-transitions
 * (`notifyForEvent`, mirroring the notification-sound events). Clicking the toast switches to the
 * desktop/Space holding the window and focuses it.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { NotifySoundEvent } from './vibeNotifySoundService.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.notifications.desktopApprovals.enabled': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.notifications.desktopApprovals.enabled', 'Показывать desktop-уведомления ОС, когда агент ждёт вашего подтверждения.'),
		},
		'vibeide.notifications.desktopApprovals.throttleMs': {
			type: 'number',
			default: 30000,
			minimum: 5000,
			maximum: 300000,
			description: localize('vibeide.notifications.desktopApprovals.throttleMs', 'Минимум миллисекунд между desktop-уведомлениями одного типа. Защищает от спама.'),
		},
		'vibeide.notifications.desktopApprovals.events': {
			type: 'array',
			items: { type: 'string', enum: ['tool_approval', 'pre_flight', 'dead_mans_switch', 'plan_consent', 'trust_score_critical'] },
			default: ['tool_approval', 'pre_flight', 'dead_mans_switch', 'trust_score_critical'],
			description: localize('vibeide.notifications.desktopApprovals.events', 'Какие события агента вызывают desktop-уведомление.'),
		},
		'vibeide.notify.desktop.enabled': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.notify.desktop.enabled', 'Когда агент завершил работу, остановился или ждёт вашего ответа, а IDE свёрнута или в фоне: мигать иконкой в панели задач (на macOS — прыжок в Dock) и показывать системный тоаст. Клик по иконке или тоасту переключает на рабочий стол с VibeIDE и фокусирует окно.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type ApprovalEventType = 'tool_approval' | 'pre_flight' | 'dead_mans_switch' | 'plan_consent' | 'trust_score_critical';

export interface DesktopApprovalNotification {
	type: ApprovalEventType;
	title: string;
	body: string;
	/** If true, throttle is bypassed (for critical events) */
	urgent?: boolean;
}

export const IVibeDesktopNotificationService = createDecorator<IVibeDesktopNotificationService>('vibeDesktopNotificationService');

export interface IVibeDesktopNotificationService {
	readonly _serviceBrand: undefined;

	/** Notify user that the agent is waiting for an approval. Respects throttle and enable setting. */
	notifyApprovalNeeded(notification: DesktopApprovalNotification): void;

	/**
	 * Fire an OS toast for a thread state-transition (turn complete / stalled / awaiting user),
	 * mirroring the notification-sound events. Only fires when the IDE is in the background; clicking
	 * the toast switches to the IDE's desktop and focuses it. Respects `vibeide.notify.desktop.enabled`.
	 */
	notifyForEvent(event: NotifySoundEvent): void;

	/** Dismiss any pending notification for a given event type (e.g. after user approves). */
	dismissForType(type: ApprovalEventType): void;
}
