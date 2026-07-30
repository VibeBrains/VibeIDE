/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «VibeIDE: Проверить запуск» — the report that answers what the agent will be allowed to do,
 * without starting it.
 *
 * The user picks the main agent or one role; the preflight service collects the facts, the pure
 * evaluator decides what they mean, and the result opens as a rendered markdown report (same
 * shape as the context and spend reports).
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { evaluateLaunchPlan, renderPreflightMarkdown } from '../common/agentLaunchPreflight.js';
import { IVibeAgentPreflightService } from './vibeAgentPreflightService.js';
import { IVibeSubagentRegistryService } from '../common/vibeSubagentRegistryService.js';
import type { SubagentType } from '../common/vibeSubagentService.js';

export const VIBEIDE_AGENT_PREFLIGHT_ACTION_ID = 'vibeide.agents.preflight';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_AGENT_PREFLIGHT_ACTION_ID,
			// No `category` here: the palette prefixes the title with it, and the title already
			// carries «VibeIDE» — together they rendered as «VibeIDE: VibeIDE: Проверить запуск».
			title: localize2('vibeide.agents.preflight', "VibeIDE: Проверить запуск"),
			f1: true,
			icon: Codicon.shield,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Every service is captured before the first await — the accessor dies with the
		// synchronous part of run().
		const preflight = accessor.get(IVibeAgentPreflightService);
		const registry = accessor.get(IVibeSubagentRegistryService);
		const quickInput = accessor.get(IQuickInputService);
		const modelService = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);

		const roles = registry.listPresets();
		const picked = await quickInput.pick(
			[
				{
					label: localize('vibeide.preflight.mainAgent', 'Основной агент'),
					description: localize('vibeide.preflight.mainAgentHint', 'Текущий режим чата и выбранная модель'),
					role: undefined as SubagentType | undefined,
				},
				...roles.map(preset => ({
					label: preset.displayName,
					description: localize('vibeide.preflight.roleHint', 'Роль-субагент со своим списком инструментов'),
					role: preset.type as SubagentType | undefined,
				})),
			],
			{
				title: localize('vibeide.preflight.pickTitle', 'Проверить запуск: чьи права показать?'),
				placeHolder: localize('vibeide.preflight.pickPlaceholder', 'Ничего не запустится — только отчёт о правилах'),
			}
		);
		if (!picked) {
			return;
		}

		const facts = picked.role ? preflight.collectForRole(picked.role) : preflight.collectForAgent();
		const content = renderPreflightMarkdown(facts, evaluateLaunchPlan(facts));

		const uri = URI.parse(`untitled://vibeide-preflight-${Date.now()}.md`);
		const ref = await modelService.createModelReference(uri);
		ref.object.textEditorModel?.setValue(content);
		ref.dispose();
		await editorService.openEditor({ resource: uri });
		try {
			await commandService.executeCommand('markdown.showPreview');
		} catch {
			// The markdown extension may be disabled — the source view is a fine outcome then.
		}
	}
});
