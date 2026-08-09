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

/** Tools whose effects live entirely outside the chat's own file tracking. */
const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
	'run_command',
	'run_persistent_command',
]);

export function isShellToolName(name: string): boolean {
	return SHELL_TOOL_NAMES.has(name);
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
	/** Whether a restore would actually change anything (undefined when unknown / no snapshot). */
	readonly wouldChangeAnything: boolean | undefined;
	/** Shell tool calls recorded in the span being rolled back. */
	readonly shellCallCount: number;
}

export function checkpointCoverage(input: CheckpointCoverageInput): CheckpointCoverage {
	const { hasSnapshot, wouldChangeAnything, shellCallCount } = input;
	if (hasSnapshot) {
		return wouldChangeAnything ? { kind: 'restorable' } : { kind: 'complete' };
	}
	// Without a snapshot there is nothing to offer; the only useful thing left is honesty, and only
	// when shell commands actually ran — otherwise the chat's own tracking did cover the changes.
	return shellCallCount > 0
		? { kind: 'uncovered', shellCallCount }
		: { kind: 'complete' };
}
