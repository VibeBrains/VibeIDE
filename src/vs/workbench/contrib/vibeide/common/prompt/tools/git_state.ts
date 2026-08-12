/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ToolDef } from './_helpers.js';

/**
 * Repository state without the terminal.
 *
 * Reading `git status` through `run_command` costs a terminal approval for what is plainly a read,
 * carries shell quoting and locale into the answer, and returns output nobody bounded. One tool
 * with a `what` selector keeps the tool list short — four separate git tools would eat four slots
 * of the budget that weak models are already drowning in.
 */
export const GIT_STATE_TOOL: ToolDef<'git_state'> = {
	name: 'git_state',
	description: `Read the state of the git repository in the open folder: what changed, the diffs of the most substantially changed files, the current branch, or recent commits. Read-only — it never stages, commits, or modifies anything. Prefer this over running git through the terminal.`,
	params: {
		what: {
			description: `Which view to return: "status" (changed files with a stat summary), "diff" (contents of the most substantially changed files, sampled so the output stays bounded), "branch" (current branch name), "log" (recent commits, merges excluded). Defaults to "status".`,
		},
	},
};
