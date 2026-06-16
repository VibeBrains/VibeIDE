/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef, uriParam } from './_helpers.js';

export const EXTRACT_FUNCTION_TOOL: ToolDef<'extract_function'> = {
	name: 'extract_function',
	// Mutates the workspace (replaces selected code with a function call) → gate like edit_file:
	// excluded from read-only Gather/Plan modes, approval-prompted in Agent mode.
	approvalType: 'edits',
	description: `Extracts a block of code into a new function. Replaces the selected code with a function call.`,
	params: {
		...uriParam('file'),
		start_line: { description: 'The starting line number (1-based) of the code block to extract.' },
		end_line: { description: 'The ending line number (1-based) of the code block to extract.' },
		function_name: { description: 'The name for the new function.' },
	},
};
