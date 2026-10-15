/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { VIBEIDE_OPEN_SETTINGS_ACTION_ID } from '../vibeideSettingsPane.js';
import { IVibeSettingsNavigationService } from '../vibeSettingsNavigationService.js';

/** The command of the palette that used to open the «Внешние агенты» tab; the agents now live in the settings and the chat */
export const VIBE_ACP_SHOW_COMMAND_ID = 'vibeide.externalAgents.show';

/** The section of the VibeIDE settings that holds the registry of external agents */
const AGENTS_SECTION = 'agents';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBE_ACP_SHOW_COMMAND_ID,
			title: localize2('vibeExternalAgentsOpen', "VibeIDE: Внешние агенты (ACP)"),
			f1: true,
			icon: Codicon.remoteExplorer,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		accessor.get(IVibeSettingsNavigationService).requestSection(AGENTS_SECTION);
		await accessor.get(ICommandService).executeCommand(VIBEIDE_OPEN_SETTINGS_ACTION_ID);
	}
});
