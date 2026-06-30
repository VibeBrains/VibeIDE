/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { cwdHelper, terminalDescHelper, ToolDef } from './_helpers.js';

export const RUN_NL_COMMAND_TOOL: ToolDef<'run_nl_command'> = {
	name: 'run_nl_command',
	description: `Converts a natural language request into a shell command, shows a preview, and executes it after confirmation. Use this when the user asks for terminal operations in plain English (e.g., "list branches", "run tests", "check git status"). The command will be parsed, previewed, and requires approval unless it's low-risk and YOLO mode is enabled. ${terminalDescHelper}`,
	params: {
		nl_input: { description: 'Natural language description of the command to run (e.g., "list git branches", "run npm tests", "check current directory").' },
		cwd: { description: cwdHelper },
	},
	approvalType: 'terminal',
};
