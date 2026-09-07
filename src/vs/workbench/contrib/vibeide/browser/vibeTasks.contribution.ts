/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import {
	Extensions as ViewContainerExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation,
} from '../../../common/views.js';
import { VibeTasksViewPane } from './vibeTasksViewPane.js';

/**
 * Где живёт доска задач.
 *
 * In the bottom panel rather than the sidebar: a board is looked at ALONGSIDE the code, not instead
 * of it, and the sidebar is already where one picks what to open. It also keeps the register next to
 * the terminal and the problems list — the other two places one glances at while working.
 */

const VIBE_TASKS_VIEWLET_ID = 'workbench.view.vibeTasks';
const VIBE_TASKS_VIEW_ID = 'workbench.view.vibeTasks.board';

/* Codicon, not Font Awesome: the panel's other tabs are outline codicons, and a filled glyph beside
 * them reads as a foreign icon set. */
const vibeTasksIcon = Codicon.checklist;

const container = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry).registerViewContainer(
	{
		id: VIBE_TASKS_VIEWLET_ID,
		title: localize2('vibeTasks.containerTitle', 'Задачи проекта'),
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIBE_TASKS_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
		hideIfEmpty: false,
		icon: vibeTasksIcon,
		order: 5,
	},
	ViewContainerLocation.Panel,
	{ doNotRegisterOpenCommand: false },
);

Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry).registerViews(
	[
		{
			id: VIBE_TASKS_VIEW_ID,
			name: localize2('vibeTasks.viewName', 'Задачи проекта'),
			containerIcon: vibeTasksIcon,
			ctorDescriptor: new SyncDescriptor(VibeTasksViewPane),
			canToggleVisibility: false,
			canMoveView: true,
			weight: 100,
			order: 1,
		},
	],
	container,
);
