/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `vibeide.chat.dismissPendingPlan` — escape hatch for threads where a TaskDecomposition plan
 * (`role: 'plan'` message with `approvalState === 'pending'`) was left un-approved.
 *
 * Background: `_runChatAgent` checks `checkPlanGenerated()` at the very top and returns to
 * `idle` if any plan in the thread is still pending. That gate is normally cleared via the
 * inline Approve/Reject buttons in the plan bubble — but if those buttons aren't visible
 * (collapsed UI, lost rendering, etc.), the thread becomes silently un-submittable: user
 * messages are added to the thread but never reach `sendLLMMessage`, no spinner appears,
 * and the next click hits `isDisabled=true` (empty textarea after submit).
 *
 * This action finds the last `role: 'plan'` message in the active thread and calls
 * `rejectPlan` on it, which clears the gate and re-enables submission.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';

registerAction2(class DismissPendingPlanAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.chat.dismissPendingPlan',
			title: localize2('vibeide.chat.dismissPendingPlan', 'Сбросить незавершённый план в текущем чате'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const notificationService = accessor.get(INotificationService);

		const threadId = chatThreadService.state.currentThreadId;
		if (!threadId) {
			notificationService.notify({ severity: Severity.Warning, message: localize('vibeide.chat.dismissPlan.noThread', 'Нет активного чата.') });
			return;
		}

		const touched = chatThreadService.dismissAllPendingPlans(threadId, { resumeBlockedMessage: true });
		if (touched === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.chat.dismissPlan.noPlan', 'В этом чате нет активных планов.') });
			return;
		}

		// Stream state is owned by dismissAllPendingPlans when resumeBlockedMessage is set:
		// it either resumes the blocked user message or clears the pending-plan-gate error.

		notificationService.notify({
			severity: Severity.Info,
			message: localize('vibeide.chat.dismissPlan.done', 'Сброшено планов: {0}. Все шаги отключены, состояние плана — aborted. Теперь можно отправлять сообщения.', String(touched)),
		});
	}
});
