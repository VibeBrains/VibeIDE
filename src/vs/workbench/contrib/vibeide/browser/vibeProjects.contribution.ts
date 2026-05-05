/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	ViewContentGroups,
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';
import { VIBE_PROJECTS_VIEWLET_ID, VIBE_PROJECTS_VIEW_ID, VibeProjectsCommands } from './vibeProjectsConstants.js';
import { VibeProjectsViewPane } from './vibeProjectsViewPane.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IVibeProjectsService } from './vibeProjectsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { extname } from '../../../../base/common/path.js';
import { IFolderToOpen, IWorkspaceToOpen } from '../../../../platform/window/common/window.js';

import './vibeProjectsService.js';

const whenVibeProjectsViewTitle = ContextKeyExpr.equals('view', VIBE_PROJECTS_VIEW_ID);
const whenVibeProjectsContainerTitle = ContextKeyExpr.equals('viewContainer', VIBE_PROJECTS_VIEWLET_ID);

/** FA6 Free Solid folder-tree (\uf802) — same glyph as web `fa-folders` / stacked folders; only Solid is bundled (not Pro Light). */
const vibeProjectsActivityGlyph = registerVibeideFaSolidIcon(
	'vibeide-vibe-projects-activity',
	'\uf802',
	localize('vibeProjects.activityIcon', 'Vibe Projects activity bar icon'),
);

const vibeProjectsViewTabIcon = registerVibeideFaSolidIcon(
	'vibeide-vibe-projects-view-tab',
	'\uf802',
	localize('vibeProjects.viewTab', 'Vibe Projects view tab'),
);

const vibeProjectsViewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const vibeProjectsViewPaneWrapper = vibeProjectsViewContainerRegistry.registerViewContainer(
	{
		id: VIBE_PROJECTS_VIEWLET_ID,
		title: localize2('vibeProjects.containerTitle', 'Vibe Projects'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_PROJECTS_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeProjectsActivityGlyph,
		order: 4,
	},
	ViewContainerLocation.Sidebar,
	{ doNotRegisterOpenCommand: true },
);

const vibeProjectsViewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
vibeProjectsViewsRegistry.registerViews(
	[
		{
			id: VIBE_PROJECTS_VIEW_ID,
			name: localize2('vibeProjects.viewName', 'Bookmarks'),
			containerIcon: vibeProjectsViewTabIcon,
			ctorDescriptor: new SyncDescriptor(VibeProjectsViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			weight: 100,
			order: 1,
			openCommandActionDescriptor: {
				id: VIBE_PROJECTS_VIEWLET_ID,
				mnemonicTitle: localize({ key: 'vibeProjects_mnemonic2', comment: ['&& denotes a mnemonic'] }, "Vibe &&Projects"),
				keybindings: {
					primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyB,
					when: ContextKeyExpr.regex('neverMatch', /doesNotMatch/),
				},
				order: 4,
			},
		},
	],
	vibeProjectsViewPaneWrapper,
);

vibeProjectsViewsRegistry.registerViewWelcomeContent(VIBE_PROJECTS_VIEW_ID, {
	content: localize(
		'vibeProjects.welcome',
		'No saved bookmarks yet.\n[Save current workspace](command:{0})\n[Open catalog.json](command:{1})',
		VibeProjectsCommands.bookmarkOpen,
		VibeProjectsCommands.revealCatalog,
	),
	when: 'default',
	group: ViewContentGroups.Open,
	order: 1,
});

const vibeCategory = localize2('vibeCategory', 'VibeIDE');

registerAction2(
	class VibeProjectsCaptureWorkspace extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.bookmarkOpen,
				title: localize2('vibeProjects.captureWorkspace', 'Vibe Projects: Save Current Workspace to List'),
				icon: Codicon.pin,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewContainerTitle, group: 'navigation', order: 0, when: whenVibeProjectsContainerTitle },
					{ id: MenuId.ViewTitle, group: 'navigation', order: 0, when: whenVibeProjectsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const workspace = accessor.get(IWorkspaceContextService);
			const notice = accessor.get(INotificationService);
			const quick = accessor.get(IQuickInputService);
			const ledger = accessor.get(IVibeProjectsService);

			if (workspace.getWorkbenchState() === WorkbenchState.EMPTY) {
				notice.info(localize('vibeProjects.needWorkspace', 'Open a folder or workspace before saving it to Vibe Projects.'));
				return;
			}

			const snapshot = workspace.getWorkspace();
			const target = snapshot.configuration ?? snapshot.folders[0]?.uri;
			if (!target) {
				notice.warn(localize('vibeProjects.nothingToPin', 'No path available to save.'));
				return;
			}

			const guess = basename(target);
			const label = await quick.input({
				title: localize('vibeProjects.inputTitle', 'Bookmark label'),
				value: guess,
				validateInput: async v => (v.trim().length ? undefined : localize('vibeProjects.emptyLabel', 'Label cannot be empty')),
			});
			if (!label?.trim()) {
				return;
			}

			await ledger.enqueuePersist({
				id: generateUuid(),
				label: label.trim(),
				target,
			});
		}
	},
);

registerAction2(
	class VibeProjectsQuickOpen extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.openPickList,
				title: localize2('vibeProjects.openQuick', 'Vibe Projects: Jump to Bookmark…'),
				icon: Codicon.listFlat,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewContainerTitle, group: 'navigation', order: 1, when: whenVibeProjectsContainerTitle },
					{ id: MenuId.ViewTitle, group: 'navigation', order: 1, when: whenVibeProjectsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const quick = accessor.get(IQuickInputService);
			const ledger = accessor.get(IVibeProjectsService);
			const host = accessor.get(IHostService);
			const notice = accessor.get(INotificationService);

			const seeds = await ledger.readEntries();
			if (!seeds.length) {
				notice.info(localize('vibeProjects.emptyRoster', 'No bookmarks yet — use Save Current Workspace.'));
				return;
			}

			type SeedPick = IQuickPickItem & { entry: (typeof seeds)[number] };
			const picks: SeedPick[] = seeds.map(s => ({ label: s.label, description: s.target.fsPath, entry: s }));
			const pick = await quick.pick(picks, { placeHolder: localize('vibeProjects.pick.placeholder', 'Select a bookmark to open') });
			const hit = pick?.entry;
			if (!hit) {
				return;
			}
			const openable: IFolderToOpen | IWorkspaceToOpen =
				extname(hit.target.fsPath) === '.code-workspace'
					? { workspaceUri: hit.target }
					: { folderUri: hit.target };
			await host.openWindow([openable], { forceNewWindow: false });
		}
	},
);

registerAction2(
	class VibeProjectsRevealCatalog extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.revealCatalog,
				title: localize2('vibeProjects.revealCatalog', 'Vibe Projects: Open catalog.json'),
				icon: Codicon.json,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewContainerTitle, group: 'navigation', order: 8, when: whenVibeProjectsContainerTitle },
					{ id: MenuId.ViewTitle, group: 'navigation', order: 8, when: whenVibeProjectsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const ledger = accessor.get(IVibeProjectsService);
			const editor = accessor.get(IEditorService);
			const files = accessor.get(IFileService);

			const uri = await ledger.ensureCatalogOnDisk();
			try {
				await files.resolve(uri);
			} catch {
				await files.writeFile(
					uri,
					VSBuffer.fromString(
						JSON.stringify({ schema: 'vibe-projects.v1', seeds: [] }, undefined, '\t'),
					),
				);
			}
			await editor.openEditor({ resource: uri, options: { pinned: true } });
		}
	},
);
