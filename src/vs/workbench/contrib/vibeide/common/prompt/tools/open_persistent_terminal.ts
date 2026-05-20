/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { cwdHelper, ToolDef } from './_helpers.js';

export const OPEN_PERSISTENT_TERMINAL_TOOL: ToolDef<'open_persistent_terminal'> = {
	name: 'open_persistent_terminal',
	description: `Use this tool when you want to run a terminal command indefinitely, like a dev server (eg \`npm run dev\`), a background listener, etc. Opens a new terminal in the user's environment which will not awaited for or killed.`,
	params: {
		cwd: { description: cwdHelper },
	},
	approvalType: 'terminal',
};
