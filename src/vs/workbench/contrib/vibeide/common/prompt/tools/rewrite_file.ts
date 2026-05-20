/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef, uriParam } from './_helpers.js';

export const REWRITE_FILE_TOOL: ToolDef<'rewrite_file'> = {
	name: 'rewrite_file',
	description: `Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.`,
	params: {
		...uriParam('file'),
		new_content: { description: `The new contents of the file. Must be a string.` },
	},
	approvalType: 'edits',
};
