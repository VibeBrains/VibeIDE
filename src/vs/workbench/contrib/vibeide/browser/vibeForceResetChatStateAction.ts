/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `vibeide.chat.forceResetChatState` — Command Palette twin of the
 * "Сбросить состояние чата" button that appears inline when the submit
 * watchdog (Stage G) detects a stuck running state. Lives as a separate
 * command so power users can hit Ctrl+Shift+P → type → recover, without
 * needing to scroll up to find the inline button.
 *
 * Mirrors the existing `vibeide.chat.dismissPendingPlan` action pattern.
 *
 * Behaviour: clears streamState for the active thread, drops pending RAF
 * updates, kills the submit watchdog timer, clears the age tracker. After
 * the action, the chat is in a clean "idle" state ready for the next send
 * — see ChatThreadService.forceResetChatState for the full reset list.
 *
 * SAFETY: this is destructive — it aborts the current request without
 * waiting for it to finish, and any partial assistant output that wasn't
 * yet committed via abortRunning is lost. Only use when the chat is stuck.
 * The button in the inline error block is preferred for normal flows
 * because it's only offered AFTER the watchdog detected a stuck state.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';

registerAction2(class ForceResetChatStateAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.chat.forceResetChatState',
			title: localize2('vibeide.chat.forceResetChatState', 'Принудительно сбросить состояние чата'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const notificationService = accessor.get(INotificationService);

		const threadId = chatThreadService.state.currentThreadId;
		if (!threadId) {
			notificationService.notify({ severity: Severity.Warning, message: localize('vibeide.chat.forceResetChatState.noThread', 'Нет активного чата.') });
			return;
		}

		const didReset = chatThreadService.forceResetChatState(threadId);
		notificationService.notify({
			severity: Severity.Info,
			message: didReset
				? localize('vibeide.chat.forceResetChatState.done', 'Состояние чата сброшено: stream state, watchdog, RAF, age tracker — всё очищено. Теперь можно отправлять сообщения.')
				: localize('vibeide.chat.forceResetChatState.noop', 'Чат уже в idle-состоянии — сбрасывать нечего.'),
		});
	}
});
