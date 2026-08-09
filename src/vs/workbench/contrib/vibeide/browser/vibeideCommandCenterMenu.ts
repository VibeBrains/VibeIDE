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
import { Codicon } from '../../../../base/common/codicons.js';
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
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { readVibeDocsFile, searchVibeDocs } from '../common/vibeDocsIndex.js';
import { VibeSpecsCommands } from './vibeSpecsConstants.js';
import { VIBEIDE_APPLY_DEFAULTS_CMD, VIBEIDE_SHOW_DEFAULTS_CMD } from './vibeDefaultsContribution.js';

// ─── Submenu ID ───────────────────────────────────────────────────────────────

/** Top-level submenu hanging off the VibeIDE sparkle in the CommandCenter. */
export const VibeideTitleBarMenuId = new MenuId('VibeideTitleBarMenu');

/** FA6 solid `brain` (private use U+F5DC). */
/**
 * Codicon `sparkle`, not the Font Awesome brain: FA Solid is a filled face on its own grid and
 * read heavier than every neighbour in the Command Center. Sparkle is also what VS Code itself
 * uses to mark AI surfaces, so the meaning survives the change of shape.
 */
export const vibeideCommandCenterBrainIcon = Codicon.sparkle;

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

// ─── Documentation search command ─────────────────────────────────────────────

export const VIBEIDE_SEARCH_DOCS_CMD = 'vibeide.searchDocs';

/**
 * Searches the documentation shipped inside this build. Lexical and offline on purpose: it answers
 * about the version actually installed, not about whatever `main` looks like today.
 *
 * Two steps rather than one dump: pick a section from the hits, then read that file in full. A
 * flat wall of excerpts is hard to act on, and the second step is where the answer usually is.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_SEARCH_DOCS_CMD,
			title: localize2('vibeideSearchDocs', 'VibeIDE: Справка — поиск по документации'),
			category: localize2('vibeCategory', 'VibeIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const query = await quickInputService.input({
			title: localize('vibeideSearchDocs.title', "Справка VibeIDE"),
			placeHolder: localize('vibeideSearchDocs.placeholder', "Что ищем? Например: servers.json, дизайн, провайдеры"),
			prompt: localize('vibeideSearchDocs.prompt', "Поиск по документации, вшитой в эту сборку — работает без сети."),
		});
		if (!query?.trim()) {
			return;
		}

		const hits = searchVibeDocs(query, 12);
		if (!hits.length) {
			notificationService.info(localize('vibeideSearchDocs.none', "По запросу «{0}» в документации ничего не найдено.", query));
			return;
		}

		const picked = await quickInputService.pick(
			hits.map(hit => ({
				label: hit.section.heading || hit.section.file,
				description: hit.section.file,
				detail: hit.excerpt,
				file: hit.section.file,
			})),
			{ title: localize('vibeideSearchDocs.pick', "Найдено: {0}", hits.length), matchOnDetail: true },
		);
		if (!picked) {
			return;
		}

		const contents = readVibeDocsFile(picked.file);
		if (!contents) {
			notificationService.warn(localize('vibeideSearchDocs.missing', "Файл {0} отсутствует в сборке.", picked.file));
			return;
		}
		const input: IUntitledTextResourceEditorInput = {
			resource: undefined,
			contents,
			languageId: 'markdown',
			options: { pinned: true },
		};
		await editorService.openEditor(input);
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

// Next to the codebase search on purpose: same question shape ("где про это?"), different corpus —
// the product's own documentation instead of the user's code.
MenuRegistry.appendMenuItem(VibeideTitleBarMenuId, {
	command: {
		id: VIBEIDE_SEARCH_DOCS_CMD,
		title: localize('vibeideSearchDocsMenu', 'Справка — поиск по документации'),
	},
	group: 'c_workspace',
	order: 4,
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
