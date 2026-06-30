/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';

// Pin-context — keyboard-accessible pin toggle for the LAST user message of the
// current thread (unambiguous target). The per-message UI button (SidebarChat)
// is the primary affordance; this command covers the keyboard-driven path.
registerAction2(class TogglePinLastUserMessageAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.chat.togglePinLastUserMessage',
			title: localize2('vibeide.chat.togglePinLastUserMessage', 'Закрепить/открепить последнее сообщение'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const notificationService = accessor.get(INotificationService);

		const threadId = chatThreadService.state.currentThreadId;
		const thread = threadId ? chatThreadService.state.allThreads[threadId] : undefined;
		if (!thread) {
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.chat.togglePin.noThread', 'Нет активного чата.') });
			return;
		}

		// Last user message — the typical "keep my instruction" target.
		let idx = -1;
		for (let i = thread.messages.length - 1; i >= 0; i--) {
			if (thread.messages[i].role === 'user') { idx = i; break; }
		}
		if (idx === -1) {
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.chat.togglePin.noUserMsg', 'В этом чате ещё нет сообщений пользователя.') });
			return;
		}

		const willPin = !(thread.messages[idx] as { pinned?: boolean }).pinned;
		chatThreadService.toggleMessagePinned({ threadId, messageIdx: idx });
		notificationService.notify({
			severity: Severity.Info,
			message: willPin
				? localize('vibeide.chat.togglePin.pinned', 'Последнее сообщение закреплено — оно не будет обрезано при сжатии контекста.')
				: localize('vibeide.chat.togglePin.unpinned', 'Последнее сообщение откреплено.'),
		});
	}
});
