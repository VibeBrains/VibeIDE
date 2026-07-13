/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
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
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';
import {
	VIBE_DOCS_ROOT_DEFAULT,
	VIBE_DOCS_ROOT_SETTING,
	VIBE_DOCS_VIEW_ID,
	VIBE_DOCS_VIEWLET_ID,
	VibeDocsCommands,
} from './vibeDocsConstants.js';
import { VibeDocsViewPane } from './vibeDocsViewPane.js';
import { IVibeDocsService } from './vibeDocsService.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';

const whenVibeDocsViewTitle = ContextKeyExpr.equals('view', VIBE_DOCS_VIEW_ID);

/** FA6 Free Solid book-open (U+F518) — reads as project documentation. */
const vibeDocsActivityGlyph = registerVibeideFaSolidIcon(
	'vibeide-vibe-docs-activity',
	'',
	localize('vibeDocs.activityIcon', 'Иконка «Документы» на панели активности'),
);

const vibeDocsViewTabIcon = registerVibeideFaSolidIcon(
	'vibeide-vibe-docs-view-tab',
	'',
	localize('vibeDocs.viewTab', 'Вкладка представления «Документы»'),
);

const vibeDocsViewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry);
const vibeDocsViewPaneWrapper = vibeDocsViewContainerRegistry.registerViewContainer(
	{
		id: VIBE_DOCS_VIEWLET_ID,
		title: localize2('vibeDocs.containerTitle', 'Документы'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_DOCS_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeDocsActivityGlyph,
		order: 0.7,
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
				category: localize2('vibeCategory', 'VibeIDE'),
				f1: true,
				menu: [
					{ id: MenuId.ViewTitle, group: 'navigation', order: 10, when: whenVibeDocsViewTitle },
				],
			});
		}

		async run(accessor: ServicesAccessor): Promise<void> {
			accessor.get(IVibeDocsService).refresh();
		}
	},
);
