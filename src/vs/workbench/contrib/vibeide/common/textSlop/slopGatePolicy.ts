/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The turn gate of the neural-slop detector: after a turn that wrote prose, the prose it wrote is checked.
 *
 * Mirrors VibeIDEA's `SlopGatePolicy` so one project behaves alike in both products: the same modes, the same default,
 * the same prose files. Pure — the chat thread reads the files and says the result.
 */

/** `vibeide.agent.slop.mode` */
export const SLOP_GATE_MODE_KEY = 'vibeide.agent.slop.mode';
/** `vibeide.agent.slop.maxAttempts` */
export const SLOP_GATE_ATTEMPTS_KEY = 'vibeide.agent.slop.maxAttempts';

/**
 * `notify` by default, as in VibeIDEA: the check costs nothing, a rewrite is another paid turn, and sending the agent
 * back for it is the person's choice
 */
export type SlopGateMode = 'off' | 'notify' | 'enforce';
export const DEFAULT_SLOP_GATE_MODE: SlopGateMode = 'notify';
export const DEFAULT_SLOP_GATE_ATTEMPTS = 2;

/** Extensions that hold prose rather than code — VibeIDEA's list (`SlopCheck.PROSE_EXTENSIONS`) */
const PROSE_EXTENSIONS: readonly string[] = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'];

/** The setting's value, or the default for anything else — a hand-edited typo must not switch the gate off in silence */
export function slopGateModeOf(value: unknown): SlopGateMode {
	return value === 'off' || value === 'notify' || value === 'enforce' ? value : DEFAULT_SLOP_GATE_MODE;
}

/** The prose among the files a turn wrote: by extension, case-insensitive, each path once, in the order written */
export function prosePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const path of paths) {
		const lower = path.toLowerCase();
		if (!seen.has(path) && PROSE_EXTENSIONS.some(extension => lower.endsWith(extension))) {
			seen.add(path);
			out.push(path);
		}
	}
	return out;
}

/**
 * What the gate does with a turn's prose
 * `skip` — off, or every file passed: a clean text gets no message in any mode
 * `report` — a note in the chat; `bounce` — the agent is sent back to rewrite; `stop` — attempts ran out, the person decides
 */
export type SlopGateDecision = 'skip' | 'report' | 'bounce' | 'stop';

export function decideSlopGate(input: { readonly mode: SlopGateMode; readonly anyFailed: boolean; readonly attemptsUsed: number; readonly maxAttempts: number; readonly canBounce: boolean }): SlopGateDecision {
	if (input.mode === 'off' || !input.anyFailed) {
		return 'skip';
	}
	if (input.mode === 'notify' || !input.canBounce) {
		return 'report';
	}
	return input.attemptsUsed < input.maxAttempts ? 'bounce' : 'stop';
}
