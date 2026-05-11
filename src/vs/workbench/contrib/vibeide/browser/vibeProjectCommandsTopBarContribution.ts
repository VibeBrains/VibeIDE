/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — top-bar pinned buttons contribution (roadmap §L321).
 *
 * Uses `pickTopBarPinned` to partition the sorted command list into
 * visible buttons + overflow. Each pinned slot renders as a status-bar
 * entry whose alignment / visibility follows the
 * `vibeide.commands.toolbar.position` setting (`titlebar` ⇒ LEFT,
 * `statusbar` ⇒ RIGHT, `hidden` ⇒ skip rendering). Overflow items remain
 * accessible via the palette.
 *
 * **L322 — Vibe Neon согласование:** Neon theme renders glow on the
 * title-bar; flipping `toolbar.position=titlebar` keeps Project Command
 * buttons in the LEFT cluster so the glow + buttons line up. Setting
 * `statusbar` moves them to the right of the status bar (so the title
 * bar stays clean for Neon's glow). Visual harmonization lives in
 * `extensions/vibeide-neon/media/vibe-neon.css` (and `vibe-neon-noglow.css`):
 * a `.statusbar-item[id^="vibeide.topbar."]` selector adds cyan/magenta
 * text-shadow (glow variant) or a quiet hover-tint (noglow variant) so the
 * entries feel native to the theme. The entry id prefix (`ENTRY_ID_PREFIX`)
 * is the contract surface — do not rename without updating the CSS.
 *
 * **L323 — context-menu DOM widget:** a document-scoped capture-phase
 * `contextmenu` listener intercepts right-clicks on our `.statusbar-item`
 * containers and opens an `IContextMenuService` menu with Run / Edit /
 * Pin or Unpin / Delete / Copy. We intercept at capture phase so the
 * status-bar part's own context menu does not fire on our entries.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { addDisposableListener, EventType, getActiveDocument } from '../../../../base/browser/dom.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, ITooltipWithCommands, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { pickTopBarPinned, PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { sortProjectCommandsForDisplay, ProjectCommand } from '../common/projectCommandsTypes.js';
import {
	decodeProjectCommandsToolbarPosition,
	ProjectCommandsToolbarPosition,
	visibleContextMenuActions,
} from '../common/projectCommandsToolbar.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { Action, IAction } from '../../../../base/common/actions.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { getWindow } from '../../../../base/browser/dom.js';

const MAX_TOP_BAR_BUTTONS = 6;
const ENTRY_ID_PREFIX = 'vibeide.topbar.';

export class VibeProjectCommandsTopBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectCommandsTopBar';

	private readonly _entries = new Map<string, IStatusbarEntryAccessor>();
	private readonly _entryDisposables = this._register(new DisposableStore());
	private _position: ProjectCommandsToolbarPosition;
	private _contextMenuListener = this._register(new DisposableStore());

	constructor(
		@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService,
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IContextMenuService private readonly _contextMenu: IContextMenuService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._position = decodeProjectCommandsToolbarPosition(
			this._config.getValue('vibeide.commands.toolbar.position'),
		);
		this._installContextMenuListener();
		this._refresh();
		this._register(this._commands.onDidChangeCommands(() => this._refresh()));
		// L322: react to position changes — re-render with new alignment + hide if `hidden`.
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.commands.toolbar.position')) {
				const next = decodeProjectCommandsToolbarPosition(
					this._config.getValue('vibeide.commands.toolbar.position'),
				);
				if (next !== this._position) {
					this._position = next;
					this._clearEntries();
					this._refresh();
				}
			}
		}));
	}

	private _clearEntries(): void {
		for (const [, entry] of this._entries) {
			entry.dispose();
		}
		this._entries.clear();
	}

	private _refresh(): void {
		// L322: `hidden` ⇒ render nothing (palette + keybindings stay live).
		if (this._position === 'hidden') {
			this._clearEntries();
			return;
		}
		const alignment = this._position === 'statusbar' ? StatusbarAlignment.RIGHT : StatusbarAlignment.LEFT;
		const all = this._commands.getCommands();
		const sorted = sortProjectCommandsForDisplay(all);
		const { pinned } = pickTopBarPinned(sorted, MAX_TOP_BAR_BUTTONS);

		const pinnedIds = new Set(pinned.map(c => c.id));
		for (const [id, entry] of this._entries) {
			if (!pinnedIds.has(id)) {
				entry.dispose();
				this._entries.delete(id);
			}
		}

		for (let i = 0; i < pinned.length; i++) {
			const cmd = pinned[i];
			const label = cmd.icon ? `$(${cmd.icon}) ${cmd.name}` : cmd.name;
			const tooltipContent = cmd.description ?? cmd.name;
			// Tooltip mirrors the right-click menu (a11y / hover fallback).
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
				command: PROJECT_COMMANDS_PALETTE_IDS.run,
			};
			const statusbarEntryId = `${ENTRY_ID_PREFIX}${cmd.id}`;
			const existing = this._entries.get(cmd.id);
			if (existing) {
				existing.update(props);
			} else {
				// Priority 100 − i so leftmost-pinned wins (LEFT) / rightmost (RIGHT).
				const accessor = this._statusbar.addEntry(props, statusbarEntryId, alignment, 100 - i);
				this._entries.set(cmd.id, accessor);
				this._entryDisposables.add({ dispose: () => { accessor.dispose(); this._entries.delete(cmd.id); } });
			}
		}
	}

	/**
	 * L323: capture-phase document listener that intercepts right-clicks on our
	 * status-bar entries (id prefix `vibeide.topbar.`) and pops an
	 * IContextMenuService menu. Capture phase keeps the status-bar part's own
	 * context menu from firing on our buttons.
	 */
	private _installContextMenuListener(): void {
		this._contextMenuListener.clear();
		const doc = getActiveDocument();
		this._contextMenuListener.add(addDisposableListener(doc, EventType.CONTEXT_MENU, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			const item = target.closest<HTMLElement>('.statusbar-item');
			if (!item) return;
			const entryId = item.id;
			if (!entryId.startsWith(ENTRY_ID_PREFIX)) return;
			const commandId = entryId.slice(ENTRY_ID_PREFIX.length);
			const cmd = this._commands.getCommand(commandId);
			if (!cmd) return;
			// Hijack the event so the status-bar part listener does not fire.
			e.preventDefault();
			e.stopPropagation();
			const std = new StandardMouseEvent(getWindow(item), e);
			this._contextMenu.showContextMenu({
				getAnchor: () => std,
				getActions: () => this._buildContextActions(cmd),
			});
		}, true));
	}

	private _buildContextActions(cmd: ProjectCommand): IAction[] {
		const isPinned = cmd.pinned === true;
		const visible = visibleContextMenuActions({ pinned: isPinned });
		const actions: IAction[] = [];
		for (const a of visible) {
			switch (a) {
				case 'run':
					actions.push(new Action('vibeide.topbar.ctx.run', localize('vibeide.topbar.ctx.run', 'Run'), undefined, true,
						async () => { await this._commands.run(cmd.id); }));
					break;
				case 'edit':
					actions.push(new Action('vibeide.topbar.ctx.edit', localize('vibeide.topbar.ctx.edit', 'Edit'), undefined, true,
						async () => { await this._commandService.executeCommand(PROJECT_COMMANDS_PALETTE_IDS.edit); }));
					break;
				case 'unpin':
					actions.push(new Action('vibeide.topbar.ctx.unpin', localize('vibeide.topbar.ctx.unpin', 'Unpin'), undefined, true,
						async () => { await this._commandService.executeCommand(PROJECT_COMMANDS_PALETTE_IDS.unpin); }));
					break;
				case 'delete':
					actions.push(new Action('vibeide.topbar.ctx.delete', localize('vibeide.topbar.ctx.delete', 'Delete'), undefined, true,
						async () => { await this._commandService.executeCommand(PROJECT_COMMANDS_PALETTE_IDS.delete); }));
					break;
				case 'copy-command-line':
					actions.push(new Action('vibeide.topbar.ctx.copy', localize('vibeide.topbar.ctx.copy', 'Copy command line'), undefined, true,
						async () => { await this._commandService.executeCommand('vibeide.commands.copyCommandLine'); }));
					break;
			}
		}
		return actions;
	}
}

registerWorkbenchContribution2(
	VibeProjectCommandsTopBarContribution.ID,
	VibeProjectCommandsTopBarContribution,
	WorkbenchPhase.AfterRestored,
);
