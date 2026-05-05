/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions, IViewContainersRegistry,
	ViewContainerLocation, IViewsRegistry, Extensions as ViewExtensions,
	IViewDescriptorService,
} from '../../../common/views.js';

import * as nls from '../../../../nls.js';

// import { Codicon } from '../../../../base/common/codicons.js';
// import { localize } from '../../../../nls.js';
// import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';

import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
// import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';


import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';

import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
// import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { mountSidebar } from './react/out/sidebar-tsx/index.js';

import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
// import { IDisposable } from '../../../../base/common/lifecycle.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { FileAccess } from '../../../../base/common/network.js';

// compare against search.contribution.ts and debug.contribution.ts, scm.contribution.ts (source control)

// ---------- Define viewpane ----------

class SidebarViewPane extends ViewPane {

	constructor(
		options: IViewPaneOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		// @ICodeEditorService private readonly editorService: ICodeEditorService,
		// @IContextKeyService private readonly editorContextKeyService: IContextKeyService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

	}



	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		// parent.style.overflow = 'auto'
		parent.style.userSelect = 'text';

		// gets set immediately
		this.instantiationService.invokeFunction(accessor => {
			// mount react
			const disposeFn: (() => void) | undefined = mountSidebar(parent, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()));
		});
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.element.style.height = `${height}px`;
		this.element.style.width = `${width}px`;
	}

}



// ---------- Register chat view in auxiliary bar ----------

// called VIEWLET_ID in other places for some reason
export const VIBEIDE_VIEW_CONTAINER_ID = 'workbench.view.vibeide';
export const VIBEIDE_VIEW_ID = VIBEIDE_VIEW_CONTAINER_ID;

// Register view container
const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const container = viewContainerRegistry.registerViewContainer({
	id: VIBEIDE_VIEW_CONTAINER_ID,
	title: nls.localize2('vibeContainer', 'Chat'), // Chat container (Ctrl + L)
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBEIDE_VIEW_CONTAINER_ID, {
		mergeViewWithContainerWhenSingleView: true,
		orientation: Orientation.HORIZONTAL,
	}]),
	hideIfEmpty: false,
	order: 1,

	rejectAddedViews: true,
	icon: FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-icon.png'), // VibeIDE logo


}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true, isDefault: true });



// Register search default location to the container (sidebar)
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
viewsRegistry.registerViews([{
	id: VIBEIDE_VIEW_ID,
	hideByDefault: false, // start open
	containerIcon: FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-icon.png'), // VibeIDE logo
	name: nls.localize2('vibeChat', ''), // this says ... : CHAT
	ctorDescriptor: new SyncDescriptor(SidebarViewPane),
	canToggleVisibility: false,
	canMoveView: false, // can't move this out of its container
	weight: 80,
	order: 1,
	// singleViewPaneContainerTitle: 'hi',

	// openCommandActionDescriptor: {
	// 	id: VIBEIDE_VIEW_CONTAINER_ID,
	// 	keybindings: {
	// 		primary: KeyMod.CtrlCmd | KeyCode.KeyL,
	// 	},
	// 	order: 1
	// },
}], container);


// open sidebar
export const VIBEIDE_OPEN_SIDEBAR_ACTION_ID = 'vibeide.openSidebar';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_SIDEBAR_ACTION_ID,
			title: 'Open VibeIDE Sidebar',
		});
	}
	run(accessor: ServicesAccessor): void {
		const viewsService = accessor.get(IViewsService);
		viewsService.openViewContainer(VIBEIDE_VIEW_CONTAINER_ID);
	}
});

export class SidebarStartContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.startupVibeideSidebar';
	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) {
		this.commandService.executeCommand(VIBEIDE_OPEN_SIDEBAR_ACTION_ID);
	}
}
registerWorkbenchContribution2(SidebarStartContribution.ID, SidebarStartContribution, WorkbenchPhase.AfterRestored);
