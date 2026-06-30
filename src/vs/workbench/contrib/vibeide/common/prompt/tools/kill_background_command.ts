/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const KILL_BACKGROUND_COMMAND_TOOL: ToolDef<'kill_background_command'> = {
	name: 'kill_background_command',
	description: `Stops a background command started via run_command with run_in_background=true. Idempotent — calling on an already-exited command returns killed=false but does not error.`,
	params: {
		background_id: { description: 'The background_id returned by run_command when run_in_background=true.' },
	},
	approvalType: 'terminal',
};
