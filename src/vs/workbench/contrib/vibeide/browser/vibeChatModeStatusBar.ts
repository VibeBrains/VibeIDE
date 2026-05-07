/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ChatMode } from '../common/vibeideSettingsTypes.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';

const MODE_ORDER: ChatMode[] = ['agent', 'gather', 'plan', 'normal'];

const MODE_LABEL: Record<ChatMode, string> = {
	agent: 'Agent',
	gather: 'Explore',
	plan: 'Plan',
	normal: 'Chat',
};

const MODE_ICON: Record<ChatMode, string> = {
	agent: '$(rocket)',
	gather: '$(search)',
	plan: '$(checklist)',
	normal: '$(comment-discussion)',
};

const MODE_TOOLTIP: Record<ChatMode, string> = {
	agent: 'Agent — agent runs tools, edits files, with Trust Score and constraints.',
	gather: 'Explore — read-only investigation, no writes.',
	plan: 'Plan — research and produce a Markdown plan, no mutations.',
	normal: 'Chat — plain Q&A, no tools.',
};

const CYCLE_COMMAND = 'vibeide.chat.cycleMode';

CommandsRegistry.registerCommand(CYCLE_COMMAND, async accessor => {
	const settingsService = accessor.get(IVibeideSettingsService);
	const current = settingsService.state.globalSettings.chatMode;
	const idx = MODE_ORDER.indexOf(current);
	const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
	await settingsService.setGlobalSetting('chatMode', next);
});

/**
 * Status-bar indicator for the active chat mode (Agent / Explore / Plan / Chat).
 * Click cycles modes; the same command is bindable as a keyboard shortcut.
 */
export class VibeChatModeStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeChatModeStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
		this._entry = this._statusbarService.addEntry(
			this._entryProps(),
			'vibeide.chat.mode',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 174 }, alignment: StatusbarAlignment.RIGHT }
		);
		this._register(this._settingsService.onDidChangeState(() => {
			this._entry?.update(this._entryProps());
		}));
	}

	private _entryProps(): IStatusbarEntry {
		const mode = this._settingsService.state.globalSettings.chatMode;
		const label = MODE_LABEL[mode];
		const icon = MODE_ICON[mode];
		return {
			name: localize('vibeideChatModeSbName', 'VibeIDE chat mode'),
			text: `${icon} ${label}`,
			ariaLabel: localize('vibeideChatModeSbAria', 'Chat mode: {0}. Click to cycle.', label),
			tooltip: MODE_TOOLTIP[mode] + '\n\n' + localize('vibeideChatModeSbCycle', 'Click to cycle: Agent → Explore → Plan → Chat.'),
			command: CYCLE_COMMAND,
		};
	}
}

registerWorkbenchContribution2(
	VibeChatModeStatusBarContribution.ID,
	VibeChatModeStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
