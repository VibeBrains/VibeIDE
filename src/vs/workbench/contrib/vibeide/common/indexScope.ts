/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which files of a project the repo index holds — one rule for the full walk and for every file-change event
 *
 * Folders were once skipped when their name appeared ANYWHERE in the absolute path: `out` threw away every `layout.ts`
 * and `timeout.ts`, `build` every `builder`, and a project living under a folder named like one of them indexed nothing
 * Now a folder is skipped only as a whole path segment, counted from the project root, and the project's own
 * `.gitignore` and `.vibe/ignore` decide the rest: agent worktrees, caches and build output are not the project's code
 *
 * Pure: a project-relative path in, a verdict out
 */

import { IgnoreMatcher } from './vibeIgnore.js';

/**
 * Version of the rule below, kept next to a saved index: an index built under another rule is rebuilt once in the background
 * Bump it whenever the rule changes what gets indexed, or old indexes keep the files the old rule chose
 */
export const INDEX_SCOPE_VERSION = '2';

/** Folders that are never the project's own code, whether or not `.gitignore` says so */
export const INDEX_EXCLUDED_FOLDERS: ReadonlySet<string> = new Set([
	'node_modules', '.git', 'dist', 'build', 'out',
	'.vscode', '.idea', 'coverage', '.nyc_output', '.next', '.cache',
]);

export const INDEXED_EXTENSIONS: ReadonlySet<string> = new Set([
	'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'cpp', 'c', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'scala',
	'dart', 'r', 'm', 'mm', 'sh', 'bash', 'zsh', 'fish', 'md',
]);

/** Files that describe the project whatever their extension */
const OVERVIEW_FILES: ReadonlySet<string> = new Set(['readme.md', 'package.json', 'product.json']);

/**
 * True when the path belongs in the index
 *
 * @param relPath path relative to the project root, forward slashes
 * @param isDirectory a folder is tested before the walk descends into it, so an ignored folder is never read
 * @param ignore the project's `.gitignore` and `.vibe/ignore`, when it has them
 */
export function isIndexablePath(relPath: string, isDirectory: boolean, ignore?: IgnoreMatcher): boolean {
	const path = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
	if (path === '' || path.startsWith('../')) {
		return false;
	}
	const segments = path.split('/');
	if (segments.some(segment => INDEX_EXCLUDED_FOLDERS.has(segment))) {
		return false;
	}
	if (ignore?.isIgnored(path)) {
		return false;
	}
	if (isDirectory) {
		return true;
	}
	const name = segments[segments.length - 1].toLowerCase();
	if (OVERVIEW_FILES.has(name)) {
		return true;
	}
	const dot = name.lastIndexOf('.');
	return dot > 0 && INDEXED_EXTENSIONS.has(name.slice(dot + 1));
}
