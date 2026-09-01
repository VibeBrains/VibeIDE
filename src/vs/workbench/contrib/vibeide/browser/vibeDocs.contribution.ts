/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr, ContextKeyExpression } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	ViewContentGroups,
} from '../../../common/views.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { FocusedViewContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import {
	VIBE_DOCS_CONTEXT_MENU,
	VIBE_DOCS_GRAPH_VIEW_ID,
	VIBE_DOCS_ROOT_DEFAULT,
	VIBE_DOCS_ROOT_SETTING,
	VIBE_DOCS_VIEW_ID,
	VIBE_DOCS_VIEWLET_ID,
	VibeDocsClipboardHasContext,
	VibeDocsCommands,
	VibeDocsItemTypeContext,
} from './vibeDocsConstants.js';
import { VibeDocsViewPane } from './vibeDocsViewPane.js';
import { IVibeDocsService } from './vibeDocsService.js';
import { VibeDocsGraphViewPane } from './vibeDocsGraphView.js';
import { VibeDocsGraphInput, VIBE_DOCS_GRAPH_OPEN_TITLE } from './vibeDocsGraphEditor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

const whenVibeDocsViewTitle = ContextKeyExpr.equals('view', VIBE_DOCS_VIEW_ID);

/** Codicon `book` — reads as project documentation.
 * Codicon, not Font Awesome: FA Solid is a filled face on its own grid and reads as a foreign
 * icon set beside the outline codicons the rest of the activity bar uses. */
const vibeDocsActivityGlyph = Codicon.book;

const vibeDocsViewTabIcon = Codicon.book;

const vibeDocsViewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const vibeDocsViewPaneWrapper = vibeDocsViewContainerRegistry.registerViewContainer(
	{
		id: VIBE_DOCS_VIEWLET_ID,
		title: localize2('vibeDocs.containerTitle', 'Документы'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_DOCS_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeDocsActivityGlyph,
		order: 0.51,
	},
	ViewContainerLocation.Sidebar,
	{ doNotRegisterOpenCommand: true },
);

const vibeDocsViewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);
vibeDocsViewsRegistry.registerViews(
	[
		{
			id: VIBE_DOCS_VIEW_ID,
			name: localize2('vibeDocs.viewName', 'Документы'),
			containerIcon: vibeDocsViewTabIcon,
			ctorDescriptor: new SyncDescriptor(VibeDocsViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			weight: 100,
			order: 1,
		},
		{
			// Second view in this container, so `mergeViewWithContainerWhenSingleView` no longer
			// applies: the tree gets its own collapsible header instead of borrowing the
			// container's. Collapsed by default — the tree is what the panel is for.
			id: VIBE_DOCS_GRAPH_VIEW_ID,
			name: localize2('vibeDocs.graphViewName', 'Связи документа'),
			containerIcon: vibeDocsViewTabIcon,
			ctorDescriptor: new SyncDescriptor(VibeDocsGraphViewPane),
			canToggleVisibility: true,
			canMoveView: true,
			collapsed: true,
			weight: 40,
			order: 2,
		},
	],
	vibeDocsViewPaneWrapper,
);

vibeDocsViewsRegistry.registerViewWelcomeContent(VIBE_DOCS_VIEW_ID, {
	content: localize(
		'vibeDocs.welcome',
		'Markdown-документов пока нет.\nПанель показывает `.md`/`.mdx` из папки `{0}` (настройка `vibeide.docsPanel.root`).',
		VIBE_DOCS_ROOT_DEFAULT,
	),
	when: 'default',
	group: ViewContentGroups.Open,
	order: 1,
});

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.docsPanel',
	title: localize('vibeDocs.config.title', 'VibeIDE — Документы'),
	type: 'object',
	properties: {
		[VIBE_DOCS_ROOT_SETTING]: {
			type: 'string',
			default: VIBE_DOCS_ROOT_DEFAULT,
			description: localize('vibeDocs.config.root', 'Папка воркспейса, из которой панель «Документы» показывает markdown-файлы (`.md`/`.mdx`), рекурсивно. По умолчанию `docs`. Путь относительный от корня воркспейса.'),
		},
	},
});

registerAction2(
	class VibeDocsRefresh extends Action2 {
		constructor() {
			super({
				id: VibeDocsCommands.refresh,
				title: localize2('vibeDocs.refresh', 'Документы: Обновить'),
				icon: Codicon.refresh,
				category: VIBE_COMMAND_CATEGORY,
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 30, when: whenVibeDocsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			accessor.get(IVibeDocsService).refresh();
		}
	},
);

/**
 * Row actions all run against the pane's own tree selection, so they resolve the live view
 * rather than take arguments — the context menu and the keybindings then share one entry point.
 */
function getDocsPane(accessor: ServicesAccessor): VibeDocsViewPane | undefined {
	const view = accessor.get(IViewsService).getViewWithId(VIBE_DOCS_VIEW_ID);
	return view instanceof VibeDocsViewPane ? view : undefined;
}

/** Keybindings must only fire while the docs tree itself has focus, never globally. */
const whenVibeDocsFocused = ContextKeyExpr.equals(FocusedViewContext.key, VIBE_DOCS_VIEW_ID);
const whenAnyItem = ContextKeyExpr.notEquals(VibeDocsItemTypeContext.key, 'none');
const whenFile = ContextKeyExpr.equals(VibeDocsItemTypeContext.key, 'file');

interface IDocsActionOptions {
	readonly id: VibeDocsCommands;
	readonly title: string;
	readonly icon?: ThemeIcon;
	readonly menu?: readonly IDocsMenuOptions[];
	readonly keybinding?: { readonly primary: number; readonly secondary?: number[] };
	readonly run: (pane: VibeDocsViewPane) => unknown;
}

interface IDocsMenuOptions {
	readonly id: MenuId;
	readonly group: string;
	readonly order: number;
	readonly when?: ContextKeyExpression;
}

function registerDocsAction(options: IDocsActionOptions): void {
	registerAction2(
		class extends Action2 {
			constructor() {
				super({
					id: options.id,
					title: { value: options.title, original: options.id },
					icon: options.icon,
					category: VIBE_COMMAND_CATEGORY,
					f1: false,
					keybinding: options.keybinding
						? { ...options.keybinding, weight: KeybindingWeight.WorkbenchContrib, when: whenVibeDocsFocused }
						: undefined,
					menu: options.menu?.map(m => ({ ...m })),
				});
			}

			async run(accessor: ServicesAccessor): Promise<void> {
				const pane = getDocsPane(accessor);
				if (pane) {
					await options.run(pane);
				}
			}
		},
	);
}

// --- title bar ------------------------------------------------------------------------------

registerDocsAction({
	id: VibeDocsCommands.newFile,
	title: localize('vibeDocs.newFile', "Создать файл"),
	icon: Codicon.newFile,
	menu: [
		{ id: MenuId.ViewTitle, group: 'navigation', order: 10, when: whenVibeDocsViewTitle },
		{ id: VIBE_DOCS_CONTEXT_MENU, group: '1_create', order: 10 },
	],
	run: pane => pane.startCreate('file'),
});

registerDocsAction({
	id: VibeDocsCommands.newFolder,
	title: localize('vibeDocs.newFolder', "Создать папку"),
	icon: Codicon.newFolder,
	menu: [
		{ id: MenuId.ViewTitle, group: 'navigation', order: 20, when: whenVibeDocsViewTitle },
		{ id: VIBE_DOCS_CONTEXT_MENU, group: '1_create', order: 20 },
	],
	run: pane => pane.startCreate('folder'),
});

registerDocsAction({
	id: VibeDocsCommands.collapseAll,
	title: localize('vibeDocs.collapseAll', "Свернуть все"),
	icon: Codicon.collapseAll,
	menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 40, when: whenVibeDocsViewTitle }],
	run: pane => pane.collapseAll(),
});

// --- graph ----------------------------------------------------------------------------------

/** Opens the graph tab. Not a `registerDocsAction` — it needs no docs pane and works from the palette. */
registerAction2(
	class VibeDocsShowGraph extends Action2 {
		constructor() {
			super({
				id: VibeDocsCommands.showGraph,
				title: VIBE_DOCS_GRAPH_OPEN_TITLE,
				icon: Codicon.typeHierarchy,
				category: VIBE_COMMAND_CATEGORY,
				f1: true,
				menu: [{ id: MenuId.ViewTitle, group: 'navigation', order: 35, when: whenVibeDocsViewTitle }],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			const editorService = accessor.get(IEditorService);
			const instantiationService = accessor.get(IInstantiationService);
			// One graph tab, not one per invocation.
			const existing = editorService.findEditors(VibeDocsGraphInput.RESOURCE)[0];
			await editorService.openEditor(existing?.editor ?? instantiationService.createInstance(VibeDocsGraphInput), { pinned: true });
		}
	},
);

registerDocsAction({
	id: VibeDocsCommands.revealInGraph,
	title: localize('vibeDocs.revealInGraph', "Показать в графе"),
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '0_open', order: 30, when: whenFile }],
	run: pane => pane.revealSelectedInGraph(),
});

// --- row context menu -----------------------------------------------------------------------

registerDocsAction({
	id: VibeDocsCommands.openPreview,
	title: localize('vibeDocs.openPreview', "Открыть превью"),
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '0_open', order: 10, when: whenFile }],
	run: pane => pane.openSelected('preview'),
});

registerDocsAction({
	id: VibeDocsCommands.openSource,
	title: localize('vibeDocs.openSource', "Открыть исходник"),
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '0_open', order: 20, when: whenFile }],
	run: pane => pane.openSelected('source'),
});

registerDocsAction({
	id: VibeDocsCommands.cut,
	title: localize('vibeDocs.cut', "Вырезать"),
	keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyX },
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '2_clipboard', order: 10, when: whenAnyItem }],
	run: pane => pane.cutSelected(),
});

registerDocsAction({
	id: VibeDocsCommands.copy,
	title: localize('vibeDocs.copy', "Копировать"),
	keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyC },
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '2_clipboard', order: 20, when: whenAnyItem }],
	run: pane => pane.copySelected(),
});

registerDocsAction({
	id: VibeDocsCommands.paste,
	title: localize('vibeDocs.paste', "Вставить"),
	keybinding: { primary: KeyMod.CtrlCmd | KeyCode.KeyV },
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '2_clipboard', order: 30, when: VibeDocsClipboardHasContext }],
	run: pane => pane.pasteIntoTarget(),
});

registerDocsAction({
	id: VibeDocsCommands.rename,
	title: localize('vibeDocs.rename', "Переименовать"),
	keybinding: { primary: KeyCode.F2 },
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '3_modify', order: 10, when: whenAnyItem }],
	run: pane => pane.startRename(),
});

registerDocsAction({
	id: VibeDocsCommands.delete,
	title: localize('vibeDocs.delete', "Удалить"),
	keybinding: { primary: KeyCode.Delete, secondary: [KeyMod.CtrlCmd | KeyCode.Backspace] },
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '3_modify', order: 20, when: whenAnyItem }],
	run: pane => pane.deleteSelected(),
});

registerDocsAction({
	id: VibeDocsCommands.copyPath,
	title: localize('vibeDocs.copyPath', "Копировать путь"),
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '4_path', order: 10, when: whenAnyItem }],
	run: pane => pane.copyPathOfSelected(false),
});

registerDocsAction({
	id: VibeDocsCommands.copyRelativePath,
	title: localize('vibeDocs.copyRelativePath', "Копировать относительный путь"),
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '4_path', order: 20, when: whenAnyItem }],
	run: pane => pane.copyPathOfSelected(true),
});

registerDocsAction({
	id: VibeDocsCommands.revealInOS,
	title: localize('vibeDocs.revealInOS', "Показать в системном проводнике"),
	menu: [{ id: VIBE_DOCS_CONTEXT_MENU, group: '4_path', order: 30, when: whenAnyItem }],
	run: pane => pane.revealSelectedInOS(),
});
