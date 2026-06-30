/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands ↔ VibeWorkflowService — entry-point trigger
 * (roadmap §"Интеграция с `VibeWorkflowService` — команда может быть
 * entry-point для workflow (поле `workflowId?`)").
 *
 * Pure decision helper — `vscode`-free — companion to
 * `projectCommandsTerminalPolicy.decideProjectCommandLaunch`. When a
 * project command has `workflowId` set, the runtime should hand it off to
 * `IVibeWorkflowService` instead of spawning a shell directly. This module
 * decides whether the hand-off is warranted and returns a tagged result so
 * the runtime adapter stays thin.
 */

import { ProjectCommand } from './projectCommandsTypes.js';

const WORKFLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export type WorkflowTriggerDecision =
	| { readonly kind: 'launch-workflow'; readonly workflowId: string }
	| { readonly kind: 'launch-shell' }
	| { readonly kind: 'refused'; readonly reason: 'workflow-id-malformed' | 'workflow-not-found' };

export interface WorkflowTriggerInput {
	readonly command: Pick<ProjectCommand, 'workflowId'>;
	/** ids known to `IVibeWorkflowService.list()`. */
	readonly knownWorkflowIds: ReadonlySet<string>;
}

/**
 * Decide whether to dispatch into VibeWorkflowService or fall back to the
 * regular terminal-mode launch policy.
 *
 *   - no `workflowId`         → 'launch-shell'  (regular path)
 *   - malformed id            → 'refused: workflow-id-malformed'
 *   - id not in known set     → 'refused: workflow-not-found'
 *   - otherwise               → 'launch-workflow'
 *
 * The malformed branch defends against unsanitised authoring (the JSON Schema
 * already validates, but a community pack could ship anything in raw form).
 */
export function decideWorkflowTrigger(input: WorkflowTriggerInput): WorkflowTriggerDecision {
	const id = input.command.workflowId;
	if (id === undefined || id === null) {
		return { kind: 'launch-shell' };
	}
	if (typeof id !== 'string' || !WORKFLOW_ID_PATTERN.test(id)) {
		return { kind: 'refused', reason: 'workflow-id-malformed' };
	}
	if (!input.knownWorkflowIds.has(id)) {
		return { kind: 'refused', reason: 'workflow-not-found' };
	}
	return { kind: 'launch-workflow', workflowId: id };
}

/**
 * Bulk variant for the palette / Quick Pick — reports which commands would
 * dispatch into a workflow vs spawn a shell, plus the list of refused ones.
 */
export function summarizeWorkflowTriggers(
	commands: ReadonlyArray<Pick<ProjectCommand, 'id' | 'workflowId'>>,
	knownWorkflowIds: ReadonlySet<string>,
): {
	readonly workflow: readonly { readonly commandId: string; readonly workflowId: string }[];
	readonly shell: readonly { readonly commandId: string }[];
	readonly refused: readonly { readonly commandId: string; readonly reason: 'workflow-id-malformed' | 'workflow-not-found' }[];
} {
	const workflow: { commandId: string; workflowId: string }[] = [];
	const shell: { commandId: string }[] = [];
	const refused: { commandId: string; reason: 'workflow-id-malformed' | 'workflow-not-found' }[] = [];
	for (const c of commands) {
		const r = decideWorkflowTrigger({ command: c, knownWorkflowIds });
		if (r.kind === 'launch-workflow') {
			workflow.push({ commandId: c.id, workflowId: r.workflowId });
		} else if (r.kind === 'launch-shell') {
			shell.push({ commandId: c.id });
		} else {
			refused.push({ commandId: c.id, reason: r.reason });
		}
	}
	return { workflow, shell, refused };
}
