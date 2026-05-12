/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — menubar (title-bar top-level "Project Commands" submenu).
 *
 * Surfaces the `MenubarVibeProjectCommandsMenu` ID declared in
 * `platform/actions/common/actions.ts`. Two slots:
 *
 *   group `1_add`  — static "+ Добавить команду…" item bound to
 *                    `vibeide.commands.add` (registered in
 *                    `vibeCustomCommandsContribution.ts`).
 *   group `2_list` — dynamic items, one per project command. Each click
 *                    invokes the command. Re-registered on every
 *                    `onDidChangeCommands` event (FS-watch, manual reload,
 *                    globalPaths change) — old `IDisposable`s are torn down
 *                    first so we don't accumulate ghost entries.
 *
 * Each dynamic command id is a unique synthetic id
 * (`vibeide.commands.menubarRun.<id>`) registered in `CommandsRegistry` so
 * `MenuRegistry.appendMenuItem` can bind without losing the id argument.
 * Synthetic ids dispose with the menu items.
 */

import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { sortProjectCommandsForDisplay } from '../common/projectCommandsTypes.js';

const STATIC_ADD_ITEM_ID = 'vibeide.menubar.commands.add';
const DYNAMIC_RUN_PREFIX = 'vibeide.commands.menubarRun.';

/** Static `+ Добавить команду…` entry. Registered once at module load. */
MenuRegistry.appendMenuItem(MenuId.MenubarVibeProjectCommandsMenu, {
	group: '1_add',
	order: 1,
	command: {
		id: PROJECT_COMMANDS_PALETTE_IDS.add,
		title: localize({ key: 'vibeide.menubar.commands.add', comment: ['&& denotes a mnemonic'] }, "&&+ Добавить команду…"),
	},
});

CommandsRegistry.registerCommand({
	id: STATIC_ADD_ITEM_ID,
	handler: () => { /* placeholder — never invoked; the menu item dispatches to `vibeide.commands.add` directly. */ },
});

export class VibeProjectCommandsMenubarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectCommandsMenubar';

	private readonly _dynamicEntries = this._register(new DisposableStore());

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
	) {
		super();
		this._refresh();
		this._register(this._commands.onDidChangeCommands(() => this._refresh()));
	}

	private _refresh(): void {
		// Tear down old menu items + synthetic command ids before re-registering.
		this._dynamicEntries.clear();

		const list = sortProjectCommandsForDisplay(this._commands.getCommands());
		for (let i = 0; i < list.length; i++) {
			const cmd = list[i];
			const runId = DYNAMIC_RUN_PREFIX + cmd.id;
			const commandsDisp: IDisposable = CommandsRegistry.registerCommand({
				id: runId,
				handler: async () => { await this._commands.run(cmd.id); },
			});
			const menuDisp: IDisposable = MenuRegistry.appendMenuItem(MenuId.MenubarVibeProjectCommandsMenu, {
				group: '2_list',
				order: i,
				command: {
					id: runId,
					// Pin emoji marker mirrors the status-bar pill style; keeps the dropdown skimmable.
					title: cmd.pinned ? `📌 ${cmd.name}` : cmd.name,
				},
			});
			this._dynamicEntries.add(commandsDisp);
			this._dynamicEntries.add(toDisposable(() => menuDisp.dispose()));
		}
	}

}

registerWorkbenchContribution2(
	VibeProjectCommandsMenubarContribution.ID,
	VibeProjectCommandsMenubarContribution,
	WorkbenchPhase.AfterRestored,
);
