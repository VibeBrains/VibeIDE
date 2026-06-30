/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const READ_BACKGROUND_OUTPUT_TOOL: ToolDef<'read_background_output'> = {
	name: 'read_background_output',
	description: `Returns the current stdout buffer of a background command started via run_command with run_in_background=true. Result is truncated head+tail if huge. Reports whether the command is still running.`,
	params: {
		background_id: { description: 'The background_id returned by run_command when run_in_background=true.' },
	},
	approvalType: 'terminal',
};
