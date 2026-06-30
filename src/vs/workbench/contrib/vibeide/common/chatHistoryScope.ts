/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure helpers for project-scoping of chat history. Kept dependency-free (no
 * browser/service imports) so they are unit-testable in isolation and shared
 * between the thread service and the React history lists without a circular
 * import or a duplicated storage-key constant.
 */

/** Single source of truth for the cross-window "show all projects" history toggle. */
export const HISTORY_SHOW_ALL_PROJECTS_KEY = 'vibeide.history.showAllProjects';

/** Settings key for the default scope when no toggle has been stored yet. */
export const HISTORY_DEFAULT_SHOW_ALL_KEY = 'vibeide.history.defaultShowAllProjects';

/** Minimal shape needed to decide history visibility — structural, not tied to ThreadType. */
export interface WorkspaceScoped {
	readonly workspaceId?: string;
}

/**
 * History visibility predicate. A thread is visible when the user opted to see
 * all projects, OR the thread predates project-scoping (no workspaceId → shown
 * everywhere so nothing appears lost), OR it belongs to the current workspace.
 */
export const threadMatchesWorkspace = (thread: WorkspaceScoped, currentWorkspaceId: string, showAllProjects: boolean): boolean => {
	return showAllProjects || !thread.workspaceId || thread.workspaceId === currentWorkspaceId;
};

/**
 * Strictly OWNED by the given project — used by per-project export/clear so they
 * act only on this project's own threads (not legacy/untagged or other projects).
 * A falsy `currentWorkspaceId` (folder-less window) owns nothing, so bulk
 * export/clear become no-ops there instead of touching shared untagged history.
 */
export const threadOwnedBy = (thread: WorkspaceScoped, currentWorkspaceId: string): boolean => {
	return !!currentWorkspaceId && thread.workspaceId === currentWorkspaceId;
};
