/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «Субпин» — the resume command for subagents that STOPPED by a limit and had their partial work
 * parked in a durable handoff ticket (see vibeSubagentHandoffStore). Running it opens a picker to
 * resume one stopped role manually from its saved point. The count of pending roles and the manual
 * trigger are surfaced IN THE CHAT (the «Продолжить роль» affordance next to the chat's own
 * «Продолжить») rather than a status-bar chip — this file only owns the command it invokes.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVibeSubagentOrchestratorService } from '../common/vibeSubagentOrchestratorService.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

const RESUME_COMMAND_ID = 'vibeide.subagent.resumeHandoff';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: RESUME_COMMAND_ID,
			title: localize2('vibeAgents.resumeHandoff', 'Vibe Agents: Продолжить остановленную роль'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const orchestrator = accessor.get(IVibeSubagentOrchestratorService);
		const registry = accessor.get(IVibeSubagentRegistryService);
		const notice = accessor.get(INotificationService);

		const open = orchestrator.listOpenHandoffs();
		if (open.length === 0) {
			notice.info(localize('vibeAgents.resumeHandoff.none', "Нет остановленных ролей, ожидающих продолжения."));
			return;
		}

		const picked = await quickInput.pick(
			open.map(t => ({
				label: `$(debug-continue) ${registry.getPreset(t.role).displayName}`,
				description: t.stopReason,
				detail: t.partialSummary.slice(0, 120) || localize('vibeAgents.resumeHandoff.noPartial', "(без частичного результата)"),
				ticketId: t.id,
			})),
			{ title: localize('vibeAgents.resumeHandoff.pick', "Продолжить остановленную роль"), placeHolder: localize('vibeAgents.resumeHandoff.placeholder', "Выберите роль для продолжения с сохранённого места") },
		);
		if (!picked) { return; }

		notice.info(localize('vibeAgents.resumeHandoff.started', "Продолжаю роль с сохранённого места…"));
		const result = await orchestrator.resume(picked.ticketId);
		notice.notify({
			severity: result?.status === 'success' ? Severity.Info : Severity.Warning,
			message: result?.status === 'success'
				? localize('vibeAgents.resumeHandoff.done', "Роль завершена.")
				: localize('vibeAgents.resumeHandoff.stoppedAgain', "Роль снова остановлена: {0}. Осталась в списке продолжения.", result?.reason ?? localize('vibeAgents.resumeHandoff.unknown', "неизвестно")),
		});
	}
});
