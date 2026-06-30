/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Vibe Agents — surfaces the role-routing logic (VA.3/VA.4) to the user. Shows which roles
 * (and whether security-by-default) a task would dispatch to. Execution lands with the
 * Phase-3b subagent runner; this command exposes the deterministic plan today.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IVibeSubagentOrchestratorService } from '../common/vibeSubagentOrchestratorService.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';

registerAction2(
	class VibeAgentsPlanRoute extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeAgents.planRoute',
				title: localize2('vibeAgents.planRoute', 'Vibe Agents: Показать маршрут ролей для задачи'),
				category: localize2('vibeCategory', 'VibeIDE'),
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const quickInput = accessor.get(IQuickInputService);
			const orchestrator = accessor.get(IVibeSubagentOrchestratorService);
			const notice = accessor.get(INotificationService);

			const task = await quickInput.input({
				title: localize('vibeAgents.planRoute.title', "Опишите задачу — покажу маршрут ролей"),
				placeHolder: localize('vibeAgents.planRoute.placeholder', "например: добавить страницу входа через OAuth"),
			});
			if (!task?.trim()) {
				return;
			}

			const route = orchestrator.planRoute(task.trim());
			const stages = route.stages
				.map(stage => (stage.length > 1 ? `[${stage.join(' ∥ ')}]` : stage[0]))
				.join(' → ');
			const security = route.securityAdded ? localize('vibeAgents.planRoute.security', " (+security авто)") : '';
			notice.info(localize('vibeAgents.planRoute.result', "Маршрут ({0}): {1}{2}", route.kind, stages, security));
		}
	},
);

registerAction2(
	class VibeAgentsListRoles extends Action2 {
		constructor() {
			super({
				id: 'vibeide.vibeAgents.listRoles',
				title: localize2('vibeAgents.listRoles', 'Vibe Agents: Показать роли и их права'),
				category: localize2('vibeCategory', 'VibeIDE'),
				f1: true,
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const registry = accessor.get(IVibeSubagentRegistryService);
			const quickInput = accessor.get(IQuickInputService);
			const items = registry.listPresets().map(p => ({
				label: p.displayName,
				description: p.allowedTools.includes('write_file')
					? localize('vibeAgents.roles.full', "полный доступ (запись/терминал)")
					: localize('vibeAgents.roles.readonly', "только чтение"),
				detail: p.allowedTools.join(', '),
			}));
			await quickInput.pick(items, { title: localize('vibeAgents.roles.title', "Роли субагентов и их права"), canPickMany: false });
		}
	},
);
