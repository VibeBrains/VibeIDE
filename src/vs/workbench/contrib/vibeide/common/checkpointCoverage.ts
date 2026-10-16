/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How complete a rollback to a checkpoint actually is.
 *
 * A checkpoint restores file contents the chat itself wrote. A working-folder snapshot extends that
 * to everything else — but only where one could be taken, which means a git repository. Outside one,
 * a rollback is exactly as blind as it was before: `sed -i`, `npm run format`, a code generator or
 * `rm` in the agent's terminal leave nothing to restore from.
 *
 * "Not covered" and "nothing to restore" must not look the same to the user: silence after a
 * rollback reads as "everything is back", which is the failure this module exists to prevent.
 */

import type { ChatMessage } from './chatThreadServiceTypes.js';

/**
 * Tools whose effects live entirely outside the chat's own file tracking.
 *
 * The list is shared with VibeIDEA through `testVectors/checkpoint.json` (`shellToolNames`); the test
 * `test/node/checkpointVectors.test.ts` fails when this constant and the vector drift apart.
 */
export const SHELL_TOOL_NAMES: readonly string[] = [
	'run_command',
	'run_persistent_command',
	// Same effect through a different door: the model describes the command in words and the tool
	// runs a shell command all the same.
	'run_nl_command',
];

const SHELL_TOOL_NAME_SET: ReadonlySet<string> = new Set(SHELL_TOOL_NAMES);

/** Exact comparison: another case or a prefix is not a shell tool. */
export function isShellToolName(name: string): boolean {
	return SHELL_TOOL_NAME_SET.has(name);
}

/** The ACP tool kind of a call that runs a command (`execute` in the protocol's `ToolKind`). */
export const ACP_SHELL_TOOL_KIND = 'execute';

/**
 * Names of the tool calls in a stretch of a thread, in the terms the coverage decision understands.
 *
 * The built-in agent names its tools, so a `tool` message already carries a name from `SHELL_TOOL_NAMES`.
 * An external agent runs its own tools and reports them as `acp_tool` cards with a free-form `name`
 * (`Bash`, `shell`…) and a protocol-defined `kind`; the kind is what is stable across agents, so a call
 * of kind `execute` counts as the shell tool `run_command`.
 */
export function toolNamesForCoverage(messages: readonly ChatMessage[]): string[] {
	const names: string[] = [];
	for (const message of messages) {
		if (message.role === 'tool') {
			names.push(message.name);
		} else if (message.role === 'acp_tool' && message.toolKind === ACP_SHELL_TOOL_KIND) {
			names.push(SHELL_TOOL_NAMES[0]);
		}
	}
	return names;
}

export type CheckpointCoverage =
	/** A snapshot exists and something outside the chat differs — worth offering a restore. */
	| { readonly kind: 'restorable' }
	/** A snapshot exists and nothing drifted — say nothing, the rollback is complete. */
	| { readonly kind: 'complete' }
	/**
	 * No snapshot, and the rolled-back span ran shell commands: their effects stay. This is the
	 * case the user must hear about, because the rollback looks finished and is not.
	 */
	| { readonly kind: 'uncovered'; readonly shellCallCount: number };

export interface CheckpointCoverageInput {
	/** Whether the checkpoint carries a working-folder snapshot. */
	readonly hasSnapshot: boolean;
	/** Whether a restore would actually change anything (null / undefined when unknown or no snapshot). */
	readonly wouldChangeAnything: boolean | null | undefined;
	/** Names of the tool calls recorded in the span being rolled back, both ends included. */
	readonly toolNames: readonly string[];
}

export function checkpointCoverage(input: CheckpointCoverageInput): CheckpointCoverage {
	const { hasSnapshot, wouldChangeAnything, toolNames } = input;
	const shellCallCount = toolNames.filter(isShellToolName).length;
	if (hasSnapshot) {
		return wouldChangeAnything ? { kind: 'restorable' } : { kind: 'complete' };
	}
	// Without a snapshot there is nothing to offer; the only useful thing left is honesty, and only
	// when shell commands actually ran — otherwise the chat's own tracking did cover the changes.
	return shellCallCount > 0
		? { kind: 'uncovered', shellCallCount }
		: { kind: 'complete' };
}
