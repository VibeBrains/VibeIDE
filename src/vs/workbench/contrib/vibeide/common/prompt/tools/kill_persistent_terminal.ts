/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef } from './_helpers.js';

export const KILL_PERSISTENT_TERMINAL_TOOL: ToolDef<'kill_persistent_terminal'> = {
	name: 'kill_persistent_terminal',
	description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
	params: {
		persistent_terminal_id: { description: `The ID of the persistent terminal.` },
	},
	approvalType: 'terminal',
};
