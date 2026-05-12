/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — menubar (title-bar top-level "Project Commands" submenu).
 *
 * Layout:
 *
 *   group `1_add`  — static "+ Добавить команду…" → `vibeide.commands.add`.
 *   group `2_list` — dynamic, one per project command. Each entry is a
 *                    SUBMENU (`MenuId('vibeProjectCommandItem.<id>')`) with
 *                    three actions:
 *                       ▶ Запустить    → `vibeide.commands.menubarRun.<id>`
 *                       ✎ Редактировать → `vibeide.commands.menubarEdit.<id>`
 *                       🗑 Удалить      → `vibeide.commands.menubarDelete.<id>`
 *                    Each synthetic command id is registered in
 *                    `CommandsRegistry` and disposed alongside the menu items.
 *                    Per-command MenuIds are intentionally lightweight — VS
 *                    Code's `MenuRegistry` only knows about ids it was asked
 *                    to read from, so spurious id creation has no cost.
 *
 * Re-registration happens on every `onDidChangeCommands` event (FS-watch,
 * manual reload, globalPaths change). Old `IDisposable`s in `_dynamicEntries`
 * are torn down first so we don't accumulate ghost menubar entries.
 */

import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { sortProjectCommandsForDisplay } from '../common/projectCommandsTypes.js';

const DYNAMIC_RUN_PREFIX = 'vibeide.commands.menubarRun.';
const DYNAMIC_EDIT_PREFIX = 'vibeide.commands.menubarEdit.';
const DYNAMIC_DELETE_PREFIX = 'vibeide.commands.menubarDelete.';
const DYNAMIC_SUBMENU_PREFIX = 'vibeProjectCommandItem.';
const EMPTY_PLACEHOLDER_CMD_ID = 'vibeide.commands.menubarEmptyPlaceholder';

/** Static `+ Добавить команду…` entry. Registered once at module load. */
MenuRegistry.appendMenuItem(MenuId.MenubarVibeProjectCommandsMenu, {
	group: '1_add',
	order: 1,
	command: {
		id: PROJECT_COMMANDS_PALETTE_IDS.add,
		title: localize({ key: 'vibeide.menubar.commands.add', comment: ['&& denotes a mnemonic'] }, "&&+ Добавить команду…"),
	},
});

/** Static `↻ Восстановить демо-команду` — seeds `.vibe/commands.json` with the
 *  canonical example. Visible always (even when the demo already exists; the
 *  handler is a no-op in that case + Info notification). */
MenuRegistry.appendMenuItem(MenuId.MenubarVibeProjectCommandsMenu, {
	group: '1_add',
	order: 2,
	command: {
		id: 'vibeide.commands.seedDemo',
		title: localize('vibeide.menubar.commands.seedDemo', "↻ Восстановить демо-команду"),
	},
});

/** Placeholder for empty-list state — surfaces a clickable "no commands"
 *  item under the divider so the menu doesn't look broken on a fresh
 *  workspace (or after the user deletes everything). Clicking it seeds the
 *  demo, identical to the `1_add` "↻ Восстановить демо-команду" entry, but
 *  positioned where the list normally renders. */
CommandsRegistry.registerCommand({
	id: EMPTY_PLACEHOLDER_CMD_ID,
	handler: async (accessor) => {
		const commandService = accessor.get(ICommandService);
		await commandService.executeCommand('vibeide.commands.seedDemo');
	},
});

export class VibeProjectCommandsMenubarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectCommandsMenubar';

	private readonly _dynamicEntries = this._register(new DisposableStore());

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._refresh();
		this._register(this._commands.onDidChangeCommands(() => this._refresh()));
	}

	private _refresh(): void {
		// Tear down old menu items + synthetic command ids before re-registering.
		this._dynamicEntries.clear();

		const list = sortProjectCommandsForDisplay(this._commands.getCommands());

		if (list.length === 0) {
			// Show a clickable "no commands — click to seed demo" placeholder so
			// the menu isn't visually empty on a fresh workspace. Selecting it
			// invokes `vibeide.commands.seedDemo`.
			const placeholderDisp: IDisposable = MenuRegistry.appendMenuItem(MenuId.MenubarVibeProjectCommandsMenu, {
				group: '2_list',
				order: 0,
				command: {
					id: EMPTY_PLACEHOLDER_CMD_ID,
					title: localize('vibeide.menubar.commands.emptyPlaceholder', "(нет команд — клик создаёт демо)"),
				},
			});
			this._dynamicEntries.add(toDisposable(() => placeholderDisp.dispose()));
			return;
		}

		for (let i = 0; i < list.length; i++) {
			const cmd = list[i];
			const runId = DYNAMIC_RUN_PREFIX + cmd.id;
			const editId = DYNAMIC_EDIT_PREFIX + cmd.id;
			const deleteId = DYNAMIC_DELETE_PREFIX + cmd.id;
			const submenuId = new MenuId(DYNAMIC_SUBMENU_PREFIX + cmd.id);

			// Synthetic command ids — Run/Edit/Delete. Each dispatches to the
			// canonical action; bundling here gives us per-command menu items
			// without ad-hoc arg-passing through MenuItem.command.
			const runCmdDisp: IDisposable = CommandsRegistry.registerCommand({
				id: runId,
				handler: async () => { await this._commands.run(cmd.id); },
			});
			const editCmdDisp: IDisposable = CommandsRegistry.registerCommand({
				id: editId,
				handler: async () => { await this._commandService.executeCommand('vibeide.commands.editById', cmd.id); },
			});
			const deleteCmdDisp: IDisposable = CommandsRegistry.registerCommand({
				id: deleteId,
				handler: async () => { await this._commandService.executeCommand('vibeide.commands.deleteById', cmd.id); },
			});

			// Submenu entry under the top-level menu's `2_list` group.
			const submenuItemDisp: IDisposable = MenuRegistry.appendMenuItem(MenuId.MenubarVibeProjectCommandsMenu, {
				group: '2_list',
				order: i,
				submenu: submenuId,
				title: cmd.pinned ? `📌 ${cmd.name}` : cmd.name,
			});

			// Submenu contents — Run, Edit (✎), Delete (🗑). Order chosen so the
			// most-frequent action (Run) is at the top.
			const runItemDisp: IDisposable = MenuRegistry.appendMenuItem(submenuId, {
				group: '1_run',
				order: 1,
				command: {
					id: runId,
					title: localize('vibeide.menubar.commands.itemRun', "▶ Запустить"),
				},
			});
			const editItemDisp: IDisposable = MenuRegistry.appendMenuItem(submenuId, {
				group: '2_modify',
				order: 1,
				command: {
					id: editId,
					title: localize('vibeide.menubar.commands.itemEdit', "✎ Редактировать"),
				},
			});
			const deleteItemDisp: IDisposable = MenuRegistry.appendMenuItem(submenuId, {
				group: '2_modify',
				order: 2,
				command: {
					id: deleteId,
					title: localize('vibeide.menubar.commands.itemDelete', "🗑 Удалить"),
				},
			});

			this._dynamicEntries.add(runCmdDisp);
			this._dynamicEntries.add(editCmdDisp);
			this._dynamicEntries.add(deleteCmdDisp);
			this._dynamicEntries.add(toDisposable(() => submenuItemDisp.dispose()));
			this._dynamicEntries.add(toDisposable(() => runItemDisp.dispose()));
			this._dynamicEntries.add(toDisposable(() => editItemDisp.dispose()));
			this._dynamicEntries.add(toDisposable(() => deleteItemDisp.dispose()));
		}
	}

}

registerWorkbenchContribution2(
	VibeProjectCommandsMenubarContribution.ID,
	VibeProjectCommandsMenubarContribution,
	WorkbenchPhase.AfterRestored,
);
