/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { MenuId } from '../../../../platform/actions/common/actions.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';

export const VIBE_DOCS_VIEWLET_ID = 'workbench.view.vibeDocs';
export const VIBE_DOCS_VIEW_ID = 'workbench.view.vibeDocs.list';
export const VIBE_DOCS_GRAPH_VIEW_ID = 'workbench.view.vibeDocs.graph';

/** Hops around the active doc drawn by the sidebar's local graph. Two shows context; more is soup. */
export const VIBE_DOCS_GRAPH_LOCAL_DEPTH = 2;

/** Workspace-relative folder scanned for markdown docs. Configurable via `vibeide.docsPanel.root`. */
export const VIBE_DOCS_ROOT_SETTING = 'vibeide.docsPanel.root';
export const VIBE_DOCS_ROOT_DEFAULT = 'docs';

/** Guard against pathological trees — a docs folder shouldn't be thousands of files deep. */
export const VIBE_DOCS_MAX_DEPTH = 6;

/** Markdown files the panel indexes. Shared by the scanner and the create/rename normalizer. */
export const VIBE_DOCS_MARKDOWN_RE = /\.mdx?$/i;

/** Appended when a new file is named without a markdown extension — the panel only holds markdown. */
export const VIBE_DOCS_DEFAULT_EXT = '.md';

/** Row context menu. Dedicated id, so nothing else can contribute into the docs tree. */
export const VIBE_DOCS_CONTEXT_MENU = new MenuId('VibeDocsContext');

export type VibeDocsItemType = 'file' | 'folder' | 'none';

/** What the tree focus sits on — drives `when` clauses of the row context menu. */
export const VibeDocsItemTypeContext = new RawContextKey<VibeDocsItemType>('vibeDocsItemType', 'none');

/** Whether the panel's own cut/copy buffer holds anything pasteable. */
export const VibeDocsClipboardHasContext = new RawContextKey<boolean>('vibeDocsClipboardHas', false);

export const enum VibeDocsCommands {
	refresh = 'vibeide.vibeDocs.refresh',
	collapseAll = 'vibeide.vibeDocs.collapseAll',
	newFile = 'vibeide.vibeDocs.newFile',
	newFolder = 'vibeide.vibeDocs.newFolder',
	rename = 'vibeide.vibeDocs.rename',
	delete = 'vibeide.vibeDocs.delete',
	cut = 'vibeide.vibeDocs.cut',
	copy = 'vibeide.vibeDocs.copy',
	paste = 'vibeide.vibeDocs.paste',
	copyPath = 'vibeide.vibeDocs.copyPath',
	copyRelativePath = 'vibeide.vibeDocs.copyRelativePath',
	revealInOS = 'vibeide.vibeDocs.revealInOS',
	openPreview = 'vibeide.vibeDocs.openPreview',
	openSource = 'vibeide.vibeDocs.openSource',
	showGraph = 'vibeide.vibeDocs.showGraph',
	revealInGraph = 'vibeide.vibeDocs.revealInGraph',
}
