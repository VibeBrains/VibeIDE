/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeIDE CommandCenter menu — replaces the native Copilot sparkle button
 * that was removed from agentSessionsExperiments.contribution.ts.
 *
 * Registers a sparkle (✦) button in the title-bar CommandCenter area that opens
 * a submenu with VibeIDE-specific actions:
 *   • New Chat           (Cmd/Ctrl+Alt+I; mac: Ctrl+Cmd+I)
 *   • Chat History       (no default key; command palette / menu)
 *   • VibeIDE Settings
 *   • Ключи и расход (which keys are configured and what they cost)
 *   • Open Skills Folder
 *   • Open Plans Folder
 *   • Search Codebase (AI) (Ctrl/Cmd+Shift+Q)
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IChatThreadService } from './chatThreadService.js';
import { VIBEIDE_VIEW_CONTAINER_ID } from './sidebarPane.js';
import { VIBEIDE_SHOW_CHAT_HISTORY_CMD } from './actionIDs.js';
import { VIBEIDE_TOGGLE_SETTINGS_ACTION_ID } from './vibeideSettingsPane.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IVibeProviderDashboardService } from './vibeProviderDashboard.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUntitledTextResourceEditorInput } from '../../../common/editor.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';
import { VibeSpecsCommands } from './vibeSpecsConstants.js';
import { VIBEIDE_APPLY_DEFAULTS_CMD, VIBEIDE_SHOW_DEFAULTS_CMD } from './vibeDefaultsContribution.js';

// ─── Submenu ID ───────────────────────────────────────────────────────────────

/** Top-level submenu hanging off the VibeIDE sparkle in the CommandCenter. */
export const VibeideTitleBarMenuId = new MenuId('VibeideTitleBarMenu');

/** FA6 solid `brain` (private use U+F5DC). */
export const vibeideCommandCenterBrainIcon = registerVibeideFaSolidIcon(
	'vibeide-command-center-brain',
	'\uf5dc',
	localize('vibeideCommandCenterBrainIcon', 'Иконка меню VibeIDE в командном центре заголовка.'),
);

// ─── CommandCenter entry ──────────────────────────────────────────────────────

MenuRegistry.appendMenuItem(MenuId.CommandCenter, {
	submenu: VibeideTitleBarMenuId,
	title: localize('vibeideMenu', 'VibeIDE'),
	icon: vibeideCommandCenterBrainIcon,
	order: 10001, // just before where the native sparkle was (10002)
});

// ─── Chat History command ─────────────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_SHOW_CHAT_HISTORY_CMD,
			title: localize2('vibeideChatHistory', 'VibeIDE: История чата'),
			category: localize2('vibeCategory', 'VibeIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const viewsService = accessor.get(IViewsService);

		viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
		await chatThreadService.focusCurrentChat();
		chatThreadService.requestChatHistoryPopover();
	}
});

// ─── Provider Dashboard command ───────────────────────────────────────────────

export const VIBEIDE_PROVIDER_DASHBOARD_CMD = 'vibeide.openProviderDashboard';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_PROVIDER_DASHBOARD_CMD,
			title: localize2('vibeideProviderDashboard', 'VibeIDE: Ключи и расход'),
			category: localize2('vibeCategory', 'VibeIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const dashboardService = accessor.get(IVibeProviderDashboardService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		try {
			const report = dashboardService.generateReport();
			// Open as untitled markdown editor for easy reading/copy/export
			const input: IUntitledTextResourceEditorInput = {
				resource: undefined,
				contents: report,
				languageId: 'markdown',
				options: { pinned: true },
			};
			await editorService.openEditor(input);
			// Rendered, not raw — the report is for reading; the source stays one click away.
			// `commandService` is resolved BEFORE the await above: an accessor is only valid for the
			// synchronous part of `run()`, and calling `accessor.get()` after an await throws.
			try {
				await commandService.executeCommand('markdown.showPreview');
			} catch {
				// Markdown extension disabled — the source view is an acceptable fallback.
			}
		} catch (err) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('vibeideProviderDashboardErr', 'Не удалось открыть дашборд провайдера: {0}', String(err)),
			});
		}
	}
});

// ─── VibeideTitleBarMenu items ────────────────────────────────────────────────

// ── Group a_chat ──

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibeide.cmdShiftL',
		title: localize('vibeNewChat', 'Новый чат'),
	},
	group: 'a_chat',
	order: 1,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VIBEIDE_SHOW_CHAT_HISTORY_CMD,
		title: localize('vibeideChatHistoryMenu', 'История чата'),
	},
	group: 'a_chat',
	order: 2,
});

// ── Group b_config ──

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VIBEIDE_TOGGLE_SETTINGS_ACTION_ID,
		title: localize('vibeideSettingsMenu', 'Настройки VibeIDE'),
	},
	group: 'b_config',
	order: 1,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VIBEIDE_PROVIDER_DASHBOARD_CMD,
		title: localize('vibeideProviderDashboardMenu', 'Дашборд провайдера'),
	},
	group: 'b_config',
	order: 2,
});

// ── Group c_workspace ──

// Mirrors the «Спеки» view-title action so the modal is reachable without switching panels.
MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VibeSpecsCommands.specFromTask,
		title: localize('vibeideSpecFromTask', 'Спека из задачи'),
	},
	group: 'c_workspace',
	order: 0,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibeide.skills.showFolder',
		title: localize('vibeideSkillsFolder', 'Открыть папку скиллов'),
	},
	group: 'c_workspace',
	order: 1,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibeide.plans.showPlansFolder',
		title: localize('vibe_idePlansFolder', 'Открыть папку планов'),
	},
	group: 'c_workspace',
	order: 2,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibe.codebase.query',
		title: localize('vibeideCodebaseSearch', 'Поиск по кодовой базе (ИИ)'),
	},
	group: 'c_workspace',
	order: 3,
});

// ── Group c_env ── (.vibe environment vs the release's defaults)

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VIBEIDE_SHOW_DEFAULTS_CMD,
		title: localize('vibeideShowDefaults', 'Показать новое в окружении из релиза'),
	},
	group: 'c_env',
	order: 1,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VIBEIDE_APPLY_DEFAULTS_CMD,
		title: localize('vibeideApplyDefaults', 'Обновить окружение из релиза'),
	},
	group: 'c_env',
	order: 2,
});

// ── Group d_commands ── (after search, separated by a divider)

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibeide.commands.showPalette',
		title: localize('vibeideCommandsPalette', 'VibeIDE Команды'),
	},
	group: 'd_commands',
	order: 1,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibeide.commands.checkProviders',
		title: localize('vibeideCheckProviders', 'Проверка провайдеров'),
	},
	group: 'd_commands',
	order: 2,
});

MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: 'vibeide.sounds.open',
		title: localize('vibeideSounds', 'VibeIDE Звуки'),
	},
	group: 'd_commands',
	order: 3,
});
