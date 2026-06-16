/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef, uriParam } from './_helpers.js';

export const RENAME_SYMBOL_TOOL: ToolDef<'rename_symbol'> = {
	name: 'rename_symbol',
	// Mutates the workspace (rewrites all references across files) → gate like edit_file:
	// excluded from read-only Gather/Plan modes, approval-prompted in Agent mode.
	approvalType: 'edits',
	description: `Renames a symbol (function, class, variable) at a specific position and updates all references to it across the codebase.`,
	params: {
		...uriParam('file'),
		line: { description: 'The line number (1-based) where the symbol is located.' },
		column: { description: 'The column number (1-based) where the symbol is located.' },
		new_name: { description: 'The new name for the symbol.' },
	},
};
