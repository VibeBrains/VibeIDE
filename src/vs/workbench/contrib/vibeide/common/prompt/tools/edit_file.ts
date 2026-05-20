/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { replaceTool_description, ToolDef, uriParam } from './_helpers.js';

export const EDIT_FILE_TOOL: ToolDef<'edit_file'> = {
	name: 'edit_file',
	description: `Edit the contents of a file. You must provide the file's URI as well as a SINGLE string of SEARCH/REPLACE block(s) that will be used to apply the edit.`,
	params: {
		...uriParam('file'),
		search_replace_blocks: { description: replaceTool_description },
	},
	approvalType: 'edits',
};
