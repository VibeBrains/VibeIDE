/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export const VIBE_PROJECTS_VIEWLET_ID = 'workbench.view.vibeProjects';
export const VIBE_PROJECTS_VIEW_ID = 'workbench.view.vibeProjects.favorites';

export const enum VibeProjectsCommands {
	saveProject = 'vibeide.vibeProjects.saveProject',
	listProjects = 'vibeide.vibeProjects.listProjects',
	editProjects = 'vibeide.vibeProjects.editProjects',
	viewAsList = 'vibeide.vibeProjects.viewAsList',
	viewAsTags = 'vibeide.vibeProjects.viewAsTags',
	filterByTag = 'vibeide.vibeProjects.filterByTag',
	collapseAll = 'vibeide.vibeProjects.collapseAll',
	openSettings = 'vibeide.vibeProjects.openSettings',
}

/** True when the Favorites pane currently displays a flat list (false = grouped by tags). */
export const VIBE_PROJECTS_VIEW_AS_LIST_CONTEXT_KEY = 'vibeProjects.viewAsList';
