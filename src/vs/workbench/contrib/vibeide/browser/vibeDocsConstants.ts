/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


export const VIBE_DOCS_VIEWLET_ID = 'workbench.view.vibeDocs';
export const VIBE_DOCS_VIEW_ID = 'workbench.view.vibeDocs.list';

/** Workspace-relative folder scanned for markdown docs. Configurable via `vibeide.docsPanel.root`. */
export const VIBE_DOCS_ROOT_SETTING = 'vibeide.docsPanel.root';
export const VIBE_DOCS_ROOT_DEFAULT = 'docs';

/** Guard against pathological trees — a docs folder shouldn't be thousands of files deep. */
export const VIBE_DOCS_MAX_DEPTH = 6;

export const enum VibeDocsCommands {
	refresh = 'vibeide.vibeDocs.refresh',
}
