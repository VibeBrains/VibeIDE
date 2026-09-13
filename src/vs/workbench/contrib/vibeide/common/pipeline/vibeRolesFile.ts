/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../../base/common/resources.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { safeParseConfigJson } from '../vibeConfigJsonParser.js';

/**
 * `.vibe/roles.json` — role defaults shared by VibeIDE and VibeIDEA.
 *
 * WHY a shared file: the test paths a `qa` step may write to used to live as a constant in each
 * product, held together by «change both or neither». That is the arrangement which already broke
 * the shared set once (`pricing` → `cost*`): a duplicated list drifts silently. The file now carries
 * the list, and the constant stays only as the fallback.
 *
 * The rules are VibeIDEA's, agreed 13.09.2026, and they are chosen so that a mistake never WIDENS
 * the boundary:
 *   - no file, unparseable file, no `qa` entry — the built-in list;
 *   - `writePaths` that is not an array, or holds an empty or non-string entry — the built-in list,
 *     with a warning;
 *   - `writePaths: []` — a `qa` step may write nowhere. An empty allow-list read as «no limit» would
 *     turn a typo into the removal of the boundary.
 *
 * Pure parsing plus one small reader, so the pipeline and the delegation path read it the same way.
 */

/** What the file says about `qa`, and anything worth telling the user. */
export interface ParsedRolesFile {
	/** `undefined` — use the built-in list; `[]` — `qa` may not write at all. */
	readonly qaWritePaths?: readonly string[];
	readonly warnings: readonly string[];
}

export function parseRolesFile(raw: unknown): ParsedRolesFile {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { warnings: ['roles.json: корень должен быть объектом — действует встроенный список путей qa'] };
	}
	const roles = (raw as { roles?: unknown }).roles;
	if (!roles || typeof roles !== 'object' || Array.isArray(roles)) {
		return { warnings: [] };
	}
	const qa = (roles as Record<string, unknown>)['qa'];
	if (!qa || typeof qa !== 'object' || Array.isArray(qa)) {
		return { warnings: [] };
	}
	const writePaths = (qa as { writePaths?: unknown }).writePaths;
	if (writePaths === undefined) {
		return { warnings: [] };
	}
	if (!Array.isArray(writePaths) || writePaths.some(p => typeof p !== 'string' || p.trim().length === 0)) {
		return { warnings: ['roles.json: qa.writePaths должен быть списком непустых строк — действует встроенный список путей qa'] };
	}
	return { qaWritePaths: writePaths.map(p => (p as string).trim()), warnings: [] };
}

/** Reads `.vibe/roles.json` of the first workspace folder. A missing file is the ordinary case. */
export async function readRolesFile(fileService: IFileService, workspace: IWorkspaceContextService): Promise<ParsedRolesFile> {
	const folders = workspace.getWorkspace().folders;
	if (folders.length === 0) {
		return { warnings: [] };
	}
	let text: string;
	try {
		text = (await fileService.readFile(joinPath(folders[0].uri, '.vibe', 'roles.json'))).value.toString();
	} catch {
		return { warnings: [] };
	}
	const parsed = safeParseConfigJson(text);
	if (!parsed.ok) {
		return { warnings: [`roles.json: не разобрать JSON (${parsed.reason}) — действует встроенный список путей qa`] };
	}
	return parseRolesFile(parsed.value);
}
