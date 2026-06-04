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
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IChatThreadService } from './chatThreadService.js';
import { URI } from '../../../../base/common/uri.js';

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
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

	}



	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent);
		// parent.style.overflow = 'auto'
		parent.style.userSelect = 'text';

		// Capture-phase drop intercept: file drags from the explorer become chat staging selections.
		// Mirrors the editor-tab version in vibeideChatPane.ts so dropping into the auxiliary-bar chat
		// behaves the same as dropping into a chat editor tab.
		// Internal editor tab drags ('application/vnd.code.editor') are skipped.
		// Image/PDF blob drops (no text/uri-list) fall through to the React composer's onDrop.
		const isExternalFileDrag = (e: DragEvent): boolean => {
			const t = e.dataTransfer;
			if (!t) { return false; }
			if (t.types.includes('application/vnd.code.editor')) { return false; }
			return t.types.includes('text/uri-list');
		};
		const setDragOverFlag = (on: boolean) => {
			if (on) { parent.setAttribute('data-vibeide-chat-drag-over', 'true'); }
			else { parent.removeAttribute('data-vibeide-chat-drag-over'); }
		};
		const onDragEnterCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			e.preventDefault();
			e.stopPropagation();
			setDragOverFlag(true);
		};
		const onDragLeaveCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			const related = e.relatedTarget as Node | null;
			if (related && parent.contains(related)) { return; }
			setDragOverFlag(false);
		};
		const onDragOverCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		};
		const onDropCapture = (e: DragEvent) => {
			if (!isExternalFileDrag(e)) { return; }
			setDragOverFlag(false);
			const raw = e.dataTransfer?.getData('text/uri-list') ?? '';
			e.preventDefault();
			e.stopPropagation();

			const uris: URI[] = [];
			for (const line of raw.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith('#')) { continue; }
				try { uris.push(URI.parse(trimmed)); } catch { /* skip malformed */ }
			}
			if (uris.length === 0) { return; }

			void (async () => {
				for (const uri of uris) {
					try {
						const stat = await this.fileService.stat(uri);
						if (stat.isDirectory) {
							this.chatThreadService.addNewStagingSelection({ type: 'Folder', uri });
						} else {
							this.chatThreadService.addNewStagingSelection({
								type: 'File',
								uri,
								language: this.languageService.guessLanguageIdByFilepathOrFirstLine(uri) ?? 'plaintext',
								state: { wasAddedAsCurrentFile: false },
							});
						}
					} catch { /* skip unreadable */ }
				}
				await this.chatThreadService.focusCurrentChat();
			})();
		};
		parent.addEventListener('dragenter', onDragEnterCapture, true);
		parent.addEventListener('dragleave', onDragLeaveCapture, true);
		parent.addEventListener('dragover', onDragOverCapture, true);
		parent.addEventListener('drop', onDropCapture, true);
		this._register(toDisposable(() => {
			parent.removeEventListener('dragenter', onDragEnterCapture, true);
			parent.removeEventListener('dragleave', onDragLeaveCapture, true);
			parent.removeEventListener('dragover', onDragOverCapture, true);
			parent.removeEventListener('drop', onDropCapture, true);
			parent.removeAttribute('data-vibeide-chat-drag-over');
		}));

		// gets set immediately
		this.instantiationService.invokeFunction(accessor => {
			const disposeFn: (() => void) | undefined = this.mountReact(parent, accessor);
			this._register(toDisposable(() => disposeFn?.()));
		});
	}

	/** Mounts the combined chat surface: chat (left) + history/session-token rail (right). */
	protected mountReact(parent: HTMLElement, accessor: ServicesAccessor): (() => void) | undefined {
		return mountSidebar(parent, accessor)?.dispose;
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
// History view keeps the legacy id (== container id) for back-compat with hardcoded references.
export const VIBEIDE_VIEW_ID = VIBEIDE_VIEW_CONTAINER_ID;
// Chat is now a first-class View (refactor B): immune to editor-group merges that used to strand
// the old chat editor tab. Lives in the same AuxiliaryBar container, side-by-side: chat left, history right.
export const VIBEIDE_CHAT_VIEW_ID = 'workbench.view.vibeide.chat';

// Register view container
const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const container = viewContainerRegistry.registerViewContainer({
	id: VIBEIDE_VIEW_CONTAINER_ID,
	title: nls.localize2('vibeContainer', 'VibeIDE'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBEIDE_VIEW_CONTAINER_ID, {
		mergeViewWithContainerWhenSingleView: true,
		orientation: Orientation.HORIZONTAL, // side-by-side: chat left, history right
	}]),
	hideIfEmpty: false,
	order: 1,

	rejectAddedViews: true,
	icon: FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-icon.png'), // VibeIDE logo


}, ViewContainerLocation.AuxiliaryBar, { doNotRegisterOpenCommand: true, isDefault: true });



// Register a SINGLE chat view. Its React renders both columns internally (chat left + history/token
// rail right), so we don't split the view container — that avoids the auxiliary-bar's vertical view
// stacking (which can't do side-by-side) and keeps everything in one merge-proof View.
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
viewsRegistry.registerViews([{
	id: VIBEIDE_CHAT_VIEW_ID,
	hideByDefault: false, // start open
	containerIcon: FileAccess.asBrowserUri('vs/workbench/browser/media/vibeide-icon.png'), // VibeIDE logo
	name: nls.localize2('vibeChat', 'Chat'),
	ctorDescriptor: new SyncDescriptor(SidebarViewPane),
	canToggleVisibility: false,
	canMoveView: false, // can't move this out of its container
	weight: 100,
	order: 1,
}], container);


// open sidebar
export const VIBEIDE_OPEN_SIDEBAR_ACTION_ID = 'vibeide.openSidebar';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_SIDEBAR_ACTION_ID,
			title: nls.localize('vibeide.openSidebar.title', 'Open VibeIDE Sidebar'),
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
