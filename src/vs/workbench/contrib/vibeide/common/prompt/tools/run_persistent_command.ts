/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { MAX_TERMINAL_BG_COMMAND_TIME } from './_constants.js';
import { terminalDescHelper, ToolDef } from './_helpers.js';

export const RUN_PERSISTENT_COMMAND_TOOL: ToolDef<'run_persistent_command'> = {
	name: 'run_persistent_command',
	description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after the wall-clock cap are returned and the command keeps running). Default cap ${MAX_TERMINAL_BG_COMMAND_TIME}s — override via timeout_ms (max 600000). ${terminalDescHelper}`,
	params: {
		command: { description: 'The terminal command to run.' },
		persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.' },
		timeout_ms: { description: `Optional. Wall-clock cap before returning partial output, in milliseconds. Default ${MAX_TERMINAL_BG_COMMAND_TIME * 1000}, min 1000, max 600000.` },
	},
	approvalType: 'terminal',
};
