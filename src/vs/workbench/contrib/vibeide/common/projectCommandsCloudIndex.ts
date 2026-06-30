/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — cloud-indexer entry point (roadmap §L334, skeleton).
 *
 * When the RAG / semantic-search pipeline is wired in, it must NEVER receive
 * the `command` / `args` / `env` fields of a Project Command — only
 * `id` / `name` / `description`. `redactCommandForCloudIndex` from
 * `commandsAuditPrivacy.ts` already produces that tight shape; this module
 * is the *callsite skeleton* so downstream code has a single import surface.
 *
 * The skeleton intentionally stops short of pushing anywhere — there is no
 * RAG sink yet. When the pipeline lands, it should:
 *   1. Subscribe to `IVibeCustomCommandsService.onDidChangeCommands`.
 *   2. Call `buildProjectCommandsCloudIndexBatch(commands)` to get the
 *      redacted batch.
 *   3. Submit that batch — and ONLY that batch — to the indexer.
 *
 * Until then, the skeleton enforces the contract via tests + a clear export.
 *
 * Privacy invariants (verified by `commandsAuditPrivacy.test.ts`):
 *   - No `command`, `args`, `cwd`, `env` (keys or values), `workflowId`,
 *     `shell`, `terminal`, `singleton`, `pinned`, `order`, `icon`, `color`.
 *   - `description` is included only when present on the source.
 *
 * vscode-free: no platform imports. Safe to use from browser / node / worker.
 */

import { ProjectCommand } from './projectCommandsTypes.js';
import {
	CommandCloudIndexShape,
	redactCommandForCloudIndex,
} from './commandsAuditPrivacy.js';

/**
 * Pure: project a single ProjectCommand into the cloud-index shape. Wraps
 * `redactCommandForCloudIndex` so callers do not need to assemble the
 * intermediate `ProjectCommandRunRecord` themselves.
 *
 * Arg-empty list and missing optional fields are handled by the underlying
 * redactor — this wrapper only converts the public ProjectCommand surface
 * into the run-record shape the redactor expects.
 */
export function projectCommandToCloudIndexEntry(cmd: ProjectCommand): CommandCloudIndexShape {
	return redactCommandForCloudIndex({
		id: cmd.id,
		name: cmd.name,
		...(cmd.description !== undefined ? { description: cmd.description } : {}),
		// Required-by-shape fields the redactor still expects, but never copies through.
		command: '',
		args: [],
	});
}

/**
 * Pure: redact a whole snapshot of commands into the cloud-index batch
 * shape. The output is ordered the same way the input was passed in so
 * downstream indexers can use position-stable upsert keys.
 *
 * Deliberately does NOT deduplicate by id — the merged snapshot from
 * `IVibeCustomCommandsService.getCommands()` already collapses workspace
 * vs. globalPaths shadowing, so callers should pass that snapshot.
 */
export function buildProjectCommandsCloudIndexBatch(
	commands: ReadonlyArray<ProjectCommand>,
): readonly CommandCloudIndexShape[] {
	return commands.map(projectCommandToCloudIndexEntry);
}

/**
 * Pure: defence-in-depth assertion used by the (deferred) cloud-indexer
 * sink to fail-closed if a future refactor accidentally widens the shape.
 * Returns `true` when the entry is safe to submit; `false` otherwise.
 *
 * Callers should wrap submission in:
 *   `if (!assertCloudIndexEntryIsSafe(entry)) { drop + log; continue; }`
 * Throwing is left to the caller so it can decide whether to log + skip
 * or abort the whole batch.
 */
export function assertCloudIndexEntryIsSafe(entry: unknown): entry is CommandCloudIndexShape {
	if (!entry || typeof entry !== 'object') { return false; }
	const e = entry as Record<string, unknown>;
	if (typeof e.id !== 'string' || typeof e.name !== 'string') { return false; }
	if (e.description !== undefined && typeof e.description !== 'string') { return false; }
	const allowed = new Set(['id', 'name', 'description']);
	for (const key of Object.keys(e)) {
		if (!allowed.has(key)) { return false; }
	}
	return true;
}
