/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Draws the VibeIDE menu entry in the Command Center with an inline SVG brain instead of a font
 * glyph.
 *
 * Why not a codicon: the set has no brain, and the nearest stand-ins (sparkle, robot) either read
 * as decoration or collide with the neighbouring ⌘ button. Why not the Font Awesome brain it used
 * to be: FA Solid is a filled face and outweighed every outline icon beside it.
 *
 * Subclassing `SubmenuEntryActionViewItem` keeps all submenu behaviour (open on click, keyboard,
 * context menu) and only swaps what is painted.
 */

import { $, append } from '../../../../base/browser/dom.js';
import { IDropdownMenuActionViewItemOptions } from '../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { SubmenuEntryActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuId, SubmenuItemAction } from '../../../../platform/actions/common/actions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { VibeideTitleBarMenuId } from './vibeideCommandCenterMenu.js';
import { createBrainGlyph } from './vibeTitleBarGlyphs.js';

class VibeBrainSubmenuItem extends SubmenuEntryActionViewItem {

	constructor(
		action: SubmenuItemAction,
		options: IDropdownMenuActionViewItemOptions | undefined,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IThemeService themeService: IThemeService,
	) {
		super(action, options, keybindingService, contextMenuService, themeService);
	}

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('vibeide-brain-command-center-item');

		// The base class paints the icon as a codicon class on its own element; clearing that
		// element and appending the SVG keeps the hit area, tooltip and dropdown wiring intact.
		const iconHost = this.element ?? container;
		iconHost.classList.remove('codicon');
		for (const cls of Array.from(iconHost.classList)) {
			if (cls.startsWith('codicon-')) {
				iconHost.classList.remove(cls);
			}
		}
		iconHost.textContent = '';
		const holder = append(iconHost, $('span.vibeide-brain-glyph'));
		holder.appendChild(createBrainGlyph());
	}
}

class VibeBrainTitleBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideBrainTitleBarItem';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		this._register(actionViewItemService.register(
			MenuId.CommandCenter,
			VibeideTitleBarMenuId,
			(action, options, insta) => insta.createInstance(VibeBrainSubmenuItem, action as SubmenuItemAction, options),
		));
	}
}

registerWorkbenchContribution2(VibeBrainTitleBarContribution.ID, VibeBrainTitleBarContribution, WorkbenchPhase.AfterRestored);
