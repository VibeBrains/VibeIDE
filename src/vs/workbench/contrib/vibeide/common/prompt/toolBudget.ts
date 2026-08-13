/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * How many tools a model is handed, and which ones go first when there are too many.
 *
 * We ship 44 built-in tools plus whatever MCP adds. A frontier model reads that list and picks;
 * a 7B model from Ollama drowns in it and starts inventing names. The quirks catalog cannot help —
 * it describes the PROTOCOL (reasoning format, effort, mirroring), not how much to hand over.
 *
 * Two rules make the cut safe rather than merely small:
 *
 *  - **The core is never cut.** A budget that removes `edit_file` does not produce a lighter agent,
 *    it produces an agent that describes edits it cannot make. If the budget is smaller than the
 *    core, the core wins and the caller is told — a limit that silently breaks the loop is worse
 *    than a limit that is politely exceeded.
 *  - **The order is fixed and declared**, not "whatever the object happened to iterate as". MCP
 *    goes first because it is the most situational, then specialised built-ins from the end of the
 *    registry backwards. The same model with the same budget must get the same list every run,
 *    otherwise a reproduced bug report is not reproducible.
 */

import { InternalToolInfo } from './prompts.js';

/**
 * Tools the agent loop cannot work without: find something, look at it, change it, run it, finish.
 * Everything else is an accelerator — nice to have, survivable to lose.
 *
 * Deliberately small. Every name added here is one the smallest model must still cope with.
 */
export const CORE_TOOL_NAMES: readonly string[] = [
	'read_file',
	'ls_dir',
	'grep',
	'search_for_files',
	'edit_file',
	'create_file_or_folder',
	'run_command',
	'vibe_complete',
];

export interface ToolBudgetResult {
	readonly tools: InternalToolInfo[];
	/** Names left out, in the order they were dropped. Empty when the budget was not binding. */
	readonly dropped: readonly string[];
	/** True when the core alone exceeds the budget, so the budget could not be honoured in full. */
	readonly coreExceedsBudget: boolean;
}

/**
 * Trim a tool list down to `maxTools`, keeping the core.
 *
 * `maxTools` of 0, negative, or non-finite means "no budget" — the list passes through untouched.
 * That is the default everywhere: a frontier model must behave exactly as it did before this
 * existed, so an unset budget cannot be allowed to mean "some sensible limit".
 *
 * @param tools Tools in registry order (built-ins first, MCP appended) — the order `availableTools` returns.
 * @param builtinNames Names considered built-in; anything else is treated as MCP and dropped first.
 */
export function applyToolBudget(
	tools: readonly InternalToolInfo[],
	maxTools: number | undefined,
	builtinNames: ReadonlySet<string>,
): ToolBudgetResult {
	if (typeof maxTools !== 'number' || !Number.isFinite(maxTools) || maxTools <= 0 || tools.length <= maxTools) {
		return { tools: [...tools], dropped: [], coreExceedsBudget: false };
	}

	const core = tools.filter(t => CORE_TOOL_NAMES.includes(t.name));
	if (core.length >= maxTools) {
		// The core wins. Reported rather than silently obeyed — see the module comment.
		return { tools: core, dropped: tools.filter(t => !core.includes(t)).map(t => t.name), coreExceedsBudget: true };
	}

	// Sacrifice order: MCP first (most situational), then specialised built-ins from the end of the
	// registry backwards — the registry is ordered from foundational to specialised, so walking it
	// in reverse drops the least foundational first.
	const sacrificial = tools.filter(t => !core.includes(t));
	const mcp = sacrificial.filter(t => !builtinNames.has(t.name));
	const builtin = sacrificial.filter(t => builtinNames.has(t.name));
	const dropOrder = [...mcp, ...builtin.slice().reverse()];

	const toDrop = dropOrder.slice(0, tools.length - maxTools);
	const dropped = new Set(toDrop.map(t => t.name));
	return {
		tools: tools.filter(t => !dropped.has(t.name)),
		dropped: toDrop.map(t => t.name),
		coreExceedsBudget: false,
	};
}
