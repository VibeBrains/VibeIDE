/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef } from './_helpers.js';

export const KILL_PERSISTENT_TERMINAL_TOOL: ToolDef<'kill_persistent_terminal'> = {
	name: 'kill_persistent_terminal',
	description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
	params: {
		persistent_terminal_id: { description: `The ID of the persistent terminal.` },
	},
	approvalType: 'terminal',
};
