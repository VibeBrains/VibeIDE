/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — top-bar pinned buttons contribution (roadmap §L321).
 *
 * Uses `pickTopBarPinned` to partition the sorted command list into
 * visible buttons + overflow. Each pinned slot renders as a LEFT-aligned
 * status-bar entry so commands are accessible from the bottom bar without
 * opening the Quick Pick. Overflow items remain accessible via the palette.
 *
 * Skeleton note: actual title-bar / Command Center integration requires
 * IWorkbenchLayoutService.partSize hooks that are not yet publicly stable.
 * The status-bar approximation is functional for single-window use.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, ITooltipWithCommands, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { pickTopBarPinned, PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { sortProjectCommandsForDisplay } from '../common/projectCommandsTypes.js';
import { localize } from '../../../../nls.js';

const MAX_TOP_BAR_BUTTONS = 6;

export class VibeProjectCommandsTopBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectCommandsTopBar';

	private readonly _entries = new Map<string, IStatusbarEntryAccessor>();
	private readonly _entryDisposables = this._register(new DisposableStore());

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
	) {
		super();
		this._refresh();
		this._register(this._commands.onDidChangeCommands(() => this._refresh()));
	}

	private _refresh(): void {
		const all = this._commands.getCommands();
		const sorted = sortProjectCommandsForDisplay(all);
		const { pinned } = pickTopBarPinned(sorted, MAX_TOP_BAR_BUTTONS);

		// Remove entries no longer in pinned.
		const pinnedIds = new Set(pinned.map(c => c.id));
		for (const [id, entry] of this._entries) {
			if (!pinnedIds.has(id)) {
				entry.dispose();
				this._entries.delete(id);
			}
		}

		// Add or update pinned entries.
		for (let i = 0; i < pinned.length; i++) {
			const cmd = pinned[i];
			const label = cmd.icon ? `$(${cmd.icon}) ${cmd.name}` : cmd.name;
			const tooltipContent = cmd.description ?? cmd.name;
			// L323: context-menu actions exposed as tooltip commands (hover footer area).
			// DOM-level right-click dispatch blocked on custom widget — use hover menu as equivalent.
			const contextTooltip: ITooltipWithCommands = {
				content: tooltipContent,
				commands: [
					{ id: PROJECT_COMMANDS_PALETTE_IDS.run, title: localize('vibeide.topbar.ctx.run', 'Run') },
					{ id: PROJECT_COMMANDS_PALETTE_IDS.edit, title: localize('vibeide.topbar.ctx.edit', 'Edit') },
					{ id: PROJECT_COMMANDS_PALETTE_IDS.pin, title: localize('vibeide.topbar.ctx.pin', 'Pin') },
					{ id: PROJECT_COMMANDS_PALETTE_IDS.unpin, title: localize('vibeide.topbar.ctx.unpin', 'Unpin') },
					{ id: PROJECT_COMMANDS_PALETTE_IDS.delete, title: localize('vibeide.topbar.ctx.delete', 'Delete') },
				],
			};
			const props: IStatusbarEntry = {
				name: localize('vibeide.topbar.cmd', 'VibeIDE: {0}', cmd.name),
				text: label,
				ariaLabel: cmd.name,
				tooltip: contextTooltip,
				// Open the Quick Pick palette; per-command execution requires dynamic command registration (deferred).
				command: PROJECT_COMMANDS_PALETTE_IDS.run,
			};
			if (this._entries.has(cmd.id)) {
				this._entries.get(cmd.id)!.update(props);
			} else {
				// Priority 100 - i so pinned order is preserved (leftmost = highest priority → leftmost position).
				const accessor = this._statusbar.addEntry(props, `vibeide.topbar.${cmd.id}`, StatusbarAlignment.LEFT, 100 - i);
				this._entries.set(cmd.id, accessor);
				this._entryDisposables.add({ dispose: () => { accessor.dispose(); this._entries.delete(cmd.id); } });
			}
		}
	}
}

registerWorkbenchContribution2(
	VibeProjectCommandsTopBarContribution.ID,
	VibeProjectCommandsTopBarContribution,
	WorkbenchPhase.AfterRestored,
);
