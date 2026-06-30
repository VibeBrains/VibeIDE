/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — `vibeide.commands.globalPaths` configuration helper
 * (roadmap §"Project Commands — Global commands"). Pattern parity with
 * `vibeide.skills.globalPaths` in `vibeSkillsLibraryService.ts`.
 *
 * Pure helper — no `vscode` / `IFileService` imports — so the decoder and the
 * workspace-wins merge can be unit-tested without a workbench harness.
 */

import { ProjectCommand } from './projectCommandsTypes.js';

export type GlobalPathSkippedReason = 'not-string' | 'empty' | 'duplicate';

export interface DecodedProjectCommandsGlobalPaths {
	readonly entries: readonly string[];
	readonly skipped: readonly { readonly reason: GlobalPathSkippedReason; readonly raw: unknown }[];
}

const ABS_PATH_HINT = /^([a-zA-Z]:[\\/]|\/|~[\\/])/;

/**
 * Strict decoder for the raw `vibeide.commands.globalPaths` setting value.
 * Trims whitespace, drops non-string / empty / duplicate entries; never throws
 * — caller decides whether to log a warning or surface a banner.
 */
export function decodeProjectCommandsGlobalPaths(raw: unknown): DecodedProjectCommandsGlobalPaths {
	if (raw === undefined || raw === null) {
		return { entries: [], skipped: [] };
	}
	if (!Array.isArray(raw)) {
		return { entries: [], skipped: [{ reason: 'not-string', raw }] };
	}
	const entries: string[] = [];
	const skipped: DecodedProjectCommandsGlobalPaths['skipped'][number][] = [];
	const seen = new Set<string>();
	for (const v of raw) {
		if (typeof v !== 'string') {
			skipped.push({ reason: 'not-string', raw: v });
			continue;
		}
		const trimmed = v.trim();
		if (trimmed.length === 0) {
			skipped.push({ reason: 'empty', raw: v });
			continue;
		}
		if (seen.has(trimmed)) {
			skipped.push({ reason: 'duplicate', raw: v });
			continue;
		}
		seen.add(trimmed);
		entries.push(trimmed);
	}
	return { entries, skipped };
}

/**
 * Coarse hint for "looks like an absolute path" — does NOT validate that the
 * path exists on disk. Use only to surface an early warning: relative entries
 * in `globalPaths` will resolve against an unpredictable cwd at runtime.
 */
export function looksLikeAbsolutePath(p: string): boolean {
	return ABS_PATH_HINT.test(p);
}

export interface MergedProjectCommands {
	readonly merged: readonly ProjectCommand[];
	readonly shadowedGlobalIds: readonly string[];
}

/**
 * Workspace-wins merge: workspace commands override global commands by `id`.
 * Mirrors the conflict-resolution rule used by `vibeSkillsLibraryService` for
 * `vibeide.skills.globalPaths`.
 *
 * Order in `merged`: all workspace commands first (in input order), then
 * non-shadowed global commands (in input order). Sorting for display is
 * delegated to `sortProjectCommandsForDisplay`.
 */
export function mergeProjectCommandsByPriority(
	workspaceCommands: ReadonlyArray<ProjectCommand>,
	globalCommands: ReadonlyArray<ProjectCommand>,
): MergedProjectCommands {
	const wsIds = new Set<string>();
	const merged: ProjectCommand[] = [];
	for (const c of workspaceCommands) {
		if (wsIds.has(c.id)) {
			continue;
		}
		wsIds.add(c.id);
		merged.push(c);
	}
	const shadowedGlobalIds: string[] = [];
	const seenGlobal = new Set<string>();
	for (const g of globalCommands) {
		if (wsIds.has(g.id)) {
			shadowedGlobalIds.push(g.id);
			continue;
		}
		if (seenGlobal.has(g.id)) {
			continue;
		}
		seenGlobal.add(g.id);
		merged.push(g);
	}
	return { merged, shadowedGlobalIds };
}
