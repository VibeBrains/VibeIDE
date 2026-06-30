/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	ViewContentGroups,
} from '../../../common/views.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';
import {
	VIBE_PROJECTS_VIEW_AS_LIST_CONTEXT_KEY,
	VIBE_PROJECTS_VIEWLET_ID,
	VIBE_PROJECTS_VIEW_ID,
	VibeProjectsCommands,
} from './vibeProjectsConstants.js';
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
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';

const whenVibeProjectsViewTitle = ContextKeyExpr.equals('view', VIBE_PROJECTS_VIEW_ID);

const ViewAsListKey = new RawContextKey<boolean>(VIBE_PROJECTS_VIEW_AS_LIST_CONTEXT_KEY, true);
const whenViewIsList = ContextKeyExpr.and(whenVibeProjectsViewTitle, ContextKeyExpr.equals(VIBE_PROJECTS_VIEW_AS_LIST_CONTEXT_KEY, true));
const whenViewIsTags = ContextKeyExpr.and(whenVibeProjectsViewTitle, ContextKeyExpr.equals(VIBE_PROJECTS_VIEW_AS_LIST_CONTEXT_KEY, false));

class VibeProjectsContextKeysContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectsContextKeys';
	constructor(@IContextKeyService contextKeyService: IContextKeyService) {
		super();
		ViewAsListKey.bindTo(contextKeyService);
	}
}
registerWorkbenchContribution2(VibeProjectsContextKeysContribution.ID, VibeProjectsContextKeysContribution, WorkbenchPhase.BlockRestore);

/** FA6 Free Solid layer-group (U+F5FD) — stacked layers, reads as a projects collection. */
const vibeProjectsActivityGlyph = registerVibeideFaSolidIcon(
	'vibeide-vibe-projects-activity',
	'\uf5fd',
	localize('vibeProjects.activityIcon', 'Иконка Vibe Projects на панели активности'),
);

const vibeProjectsViewTabIcon = registerVibeideFaSolidIcon(
	'vibeide-vibe-projects-view-tab',
	'\uf5fd',
	localize('vibeProjects.viewTab', 'Вкладка представления Vibe Projects'),
);

const vibeProjectsViewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const vibeProjectsViewPaneWrapper = vibeProjectsViewContainerRegistry.registerViewContainer(
	{
		id: VIBE_PROJECTS_VIEWLET_ID,
		title: localize2('vibeProjects.containerTitle', 'Vibe Projects'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_PROJECTS_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeProjectsActivityGlyph,
		order: 0.5,
	},
	ViewContainerLocation.Sidebar,
	{ doNotRegisterOpenCommand: true },
);

const vibeProjectsViewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
vibeProjectsViewsRegistry.registerViews(
	[
		{
			id: VIBE_PROJECTS_VIEW_ID,
			name: localize2('vibeProjects.viewName', 'Избранное'),
			containerIcon: vibeProjectsViewTabIcon,
			ctorDescriptor: new SyncDescriptor(VibeProjectsViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			weight: 100,
			order: 1,
			openCommandActionDescriptor: {
				id: VIBE_PROJECTS_VIEWLET_ID,
				mnemonicTitle: localize({ key: 'vibeProjects_mnemonic2', comment: ['&& denotes a mnemonic'] }, "Vibe &&Проекты"),
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
		'Сохранённых проектов пока нет.\n[Сохранить проект](command:{0})\n[Редактировать проекты](command:{1})',
		VibeProjectsCommands.saveProject,
		VibeProjectsCommands.editProjects,
	),
	when: 'default',
	group: ViewContentGroups.Open,
	order: 1,
});

const vibeCategory = localize2('vibeCategory', 'VibeIDE');

registerAction2(
	class VibeProjectsSaveProject extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.saveProject,
				title: localize2('vibeProjects.saveProject', 'Vibe Projects: Сохранить проект'),
				icon: Codicon.save,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 10, when: whenVibeProjectsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const workspace = accessor.get(IWorkspaceContextService);
			const notice = accessor.get(INotificationService);
			const quick = accessor.get(IQuickInputService);
			const ledger = accessor.get(IVibeProjectsService);

			if (workspace.getWorkbenchState() === WorkbenchState.EMPTY) {
				notice.info(localize('vibeProjects.needWorkspace', 'Откройте папку или рабочую область перед сохранением в качестве Vibe Project.'));
				return;
			}

			const snapshot = workspace.getWorkspace();
			const target = snapshot.configuration ?? snapshot.folders[0]?.uri;
			if (!target) {
				notice.warn(localize('vibeProjects.nothingToPin', 'Нет доступного пути для сохранения.'));
				return;
			}

			const guess = basename(target);
			const label = await quick.input({
				title: localize('vibeProjects.inputTitle', 'Название проекта'),
				value: guess,
				validateInput: async v => (v.trim().length ? undefined : localize('vibeProjects.emptyLabel', 'Название не может быть пустым')),
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
	class VibeProjectsEditProjects extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.editProjects,
				title: localize2('vibeProjects.editProjects', 'Vibe Projects: Редактировать проекты'),
				icon: Codicon.edit,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 11, when: whenVibeProjectsViewTitle },
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

registerAction2(
	class VibeProjectsViewAsTags extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.viewAsTags,
				title: localize2('vibeProjects.viewAsTags', 'Vibe Projects: Показать по тегам'),
				icon: Codicon.listTree,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 12, when: whenViewIsList },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			ViewAsListKey.bindTo(accessor.get(IContextKeyService)).set(false);
		}
	},
);

registerAction2(
	class VibeProjectsViewAsList extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.viewAsList,
				title: localize2('vibeProjects.viewAsList', 'Vibe Projects: Показать списком'),
				icon: Codicon.listFlat,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 13, when: whenViewIsTags },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			ViewAsListKey.bindTo(accessor.get(IContextKeyService)).set(true);
		}
	},
);

registerAction2(
	class VibeProjectsListProjects extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.listProjects,
				title: localize2('vibeProjects.listProjects', 'Vibe Projects: Открыть проект из списка'),
				icon: Codicon.search,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 14, when: whenVibeProjectsViewTitle },
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
				notice.info(localize('vibeProjects.emptyRoster', 'Проектов пока нет — используйте «Сохранить проект».'));
				return;
			}

			type SeedPick = IQuickPickItem & { entry: (typeof seeds)[number] };
			const picks: SeedPick[] = seeds.map(s => ({ label: s.label, description: s.target.fsPath, entry: s }));
			const pick = await quick.pick(picks, { placeHolder: localize('vibeProjects.pick.placeholder', 'Выберите проект для открытия') });
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
	class VibeProjectsFilterByTag extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.filterByTag,
				title: localize2('vibeProjects.filterByTag', 'Vibe Projects: Фильтр проектов по тегу'),
				icon: Codicon.tag,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 15, when: whenVibeProjectsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const notice = accessor.get(INotificationService);
			notice.info(localize('vibeProjects.noTagsYet', 'Тегов пока нет — теги можно будет назначать проектам в одном из следующих выпусков.'));
		}
	},
);

registerAction2(
	class VibeProjectsCollapseAll extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.collapseAll,
				title: localize2('vibeProjects.collapseAll', 'Vibe Projects: Свернуть всё'),
				icon: Codicon.collapseAll,
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 16, when: whenViewIsTags },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const notice = accessor.get(INotificationService);
			notice.info(localize('vibeProjects.collapseAllStub', 'Сворачивание групп тегов появится вместе с выпуском тегов.'));
		}
	},
);

registerAction2(
	class VibeProjectsOpenSettings extends Action2 {
		constructor() {
			super({
				id: VibeProjectsCommands.openSettings,
				title: localize2('vibeProjects.openSettings', 'Vibe Projects: Открыть настройки'),
				category: vibeCategory,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: '2_settings', order: 0, when: whenVibeProjectsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const prefs = accessor.get(IPreferencesService);
			await prefs.openUserSettings({ query: 'vibeProjects' });
		}
	},
);
