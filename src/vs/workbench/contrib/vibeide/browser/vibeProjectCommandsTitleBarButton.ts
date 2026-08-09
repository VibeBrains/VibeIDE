/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — a ⌘ button in the title bar's Command Center, left of the VibeIDE brain.
 *
 * Why this exists: the top-level «Команды» menu only appears on Windows/Linux. There the menu bar
 * is drawn by `CustomMenubarControl`, whose top-level list is built from the menu registry. On
 * macOS the menu is native, and the main-process builder (`platform/menubar/electron-main/menubar.ts`)
 * hardcodes nine top-level items — our data reaches it and is dropped. Adding a tenth would mean
 * patching an upstream main-process file that every VS Code merge touches, for one platform.
 * The Command Center, by contrast, renders identically everywhere.
 *
 * Why a custom view item rather than a plain Action2 icon: the popup anchors to a DOM element, and
 * only the view item owns one. It also lets the glyph be a drawn ⌘ (see vibeTitleBarGlyphs.ts) —
 * codicons have no command symbol, and a text character would follow system-font metrics instead
 * of the icon grid.
 */

import { localize, localize2 } from '../../../../nls.js';
import { $, addDisposableListener, append, EventType, getActiveDocument } from '../../../../base/browser/dom.js';
import { IAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ActionViewItem, IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { showProjectCommandsPopup } from './vibeProjectCommandsPopup.js';
import { createCommandGlyph } from './vibeTitleBarGlyphs.js';
import { VIBEIDE_SHOW_COMMANDS_PALETTE_CMD } from './vibeCommandsPaletteContribution.js';

export const VIBEIDE_COMMANDS_TITLE_BAR_COMMAND_ID = 'vibeide.commands.openFromTitleBar';

/** Mirrors the reopen guard in vibeProjectCommandsPopupContribution: the same mousedown that
 *  dismisses the popup would otherwise immediately open a fresh one, so the button looks stuck. */
const REOPEN_GUARD_MS = 200;

class ProjectCommandsCommandCenterItem extends ActionViewItem {

	private _popup: { close: () => void } | undefined;
	private _closedAt = 0;

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IFileService private readonly _fileService: IFileService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IVibeCustomCommandsService private readonly _commandsService: IVibeCustomCommandsService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
	) {
		super(undefined, action, { ...options, icon: false, label: false });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('vibeide-commands-command-center-item');

		// Into the standard action-label, not beside it: a sibling span sits below the (empty)
		// label in the same line box and the glyph rendered 3px lower than every neighbour —
		// measured centres were 20.5 against 17.5.
		const host = this.label ?? container;
		host.textContent = '';
		const glyph = append(host, $('span.vibeide-commands-glyph'));
		glyph.appendChild(createCommandGlyph());

		container.setAttribute('role', 'button');
		container.setAttribute('aria-label', localize('vibeide.commands.titleBarAria', 'Команды проекта'));
		container.title = localize('vibeide.commands.titleBarTooltip', 'Команды проекта — запуск, правка, закрепление');

		// Mousedown on the DOCUMENT in capture phase, not on this element, and stopped immediately
		// — the same shape vibeProjectCommandsPopupContribution uses for the Windows menu button.
		// IContextView's dismiss-on-outside-click handler also listens on the document; a listener
		// bound to this element runs *after* it, so the press closed the popup before our toggle
		// saw it and the button opened only on every other click (measured: open, open, shut, shut).
		this._register(addDisposableListener(getActiveDocument(), EventType.MOUSE_DOWN, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target?.closest('.vibeide-commands-command-center-item')) {
				return;
			}
			if (e.button !== 0) {
				return;
			}
			e.preventDefault();
			e.stopImmediatePropagation();
			this._toggle();
		}, true));
	}

	/** The mousedown handler owns the interaction; the default click would also run the action,
	 *  which opens the command palette — a second surface on top of the popup. */
	override onClick(): void { }

	private _toggle(): void {
		if (this._popup) {
			this._popup.close();
			return;
		}
		if (Date.now() - this._closedAt < REOPEN_GUARD_MS) {
			return;
		}
		const anchor = this.element;
		if (!anchor) {
			return;
		}
		this._popup = showProjectCommandsPopup(
			{
				commandsService: this._commandsService,
				commandService: this._commandService,
				contextViewService: this._contextViewService,
				fileService: this._fileService,
				workspace: this._workspace,
				notifications: this._notificationService,
			},
			anchor,
			{
				onHide: () => {
					this._popup = undefined;
					this._closedAt = Date.now();
				},
			},
		);
	}

	override dispose(): void {
		this._popup?.close();
		this._popup = undefined;
		super.dispose();
	}
}

class ProjectCommandsTitleBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideProjectCommandsTitleBar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.CommandCenter,
			VIBEIDE_COMMANDS_TITLE_BAR_COMMAND_ID,
			(action, options, insta) => insta.createInstance(ProjectCommandsCommandCenterItem, action, options),
		));
	}
}

registerWorkbenchContribution2(ProjectCommandsTitleBarContribution.ID, ProjectCommandsTitleBarContribution, WorkbenchPhase.AfterRestored);

registerAction2(class VibeideOpenProjectCommandsFromTitleBar extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_COMMANDS_TITLE_BAR_COMMAND_ID,
			title: localize2('vibeide.commands.openFromTitleBar', 'VibeIDE: Команды проекта'),
			category: Categories.View,
			f1: true,
			// order < 10001 keeps it left of the VibeIDE brain (vibeideCommandCenterMenu.ts).
			menu: [{ id: MenuId.CommandCenter, order: 10000 }],
		});
	}

	// The view item above owns the click, since the popup needs a DOM anchor. Reaching the command
	// from the palette (no anchor there) falls back to the existing command palette surface.
	override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(VIBEIDE_SHOW_COMMANDS_PALETTE_CMD);
	}
});
