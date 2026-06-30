/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { MAX_TERMINAL_INACTIVE_TIME } from './_constants.js';
import { cwdHelper, terminalDescHelper, ToolDef } from './_helpers.js';

export const RUN_COMMAND_TOOL: ToolDef<'run_command'> = {
	name: 'run_command',
	description: `Runs a terminal command and waits for the result. Default behavior: returns after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity. For long-running builds/tests/CI, pass timeout_ms (up to 600000 = 10 min). For dev servers / watch tasks / anything that never exits, pass run_in_background=true and use read_background_output / kill_background_command. ${terminalDescHelper}`,
	params: {
		command: { description: 'The terminal command to run.' },
		cwd: { description: cwdHelper },
		timeout_ms: { description: `Optional. Inactivity timeout in milliseconds. Default ${MAX_TERMINAL_INACTIVE_TIME * 1000}, min 1000, max 600000.` },
		run_in_background: { description: 'Optional. Default false. When true, the command runs detached and returns a background_id immediately. Use this for dev servers, watchers, or anything that does not terminate. Poll output with read_background_output, stop with kill_background_command.' },
	},
	approvalType: 'terminal',
};
