/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { replaceTool_description, ToolDef, uriParam } from './_helpers.js';

export const EDIT_FILE_TOOL: ToolDef<'edit_file'> = {
	name: 'edit_file',
	description: `Edit the contents of a file. PREFERRED: pass the exact text to replace as \`old_string\` and the replacement as \`new_string\` (two plain string params — simplest and most reliable). Advanced/legacy: pass one \`search_replace_blocks\` string with explicit markers. Provide the file's URI either way.`,
	params: {
		...uriParam('file'),
		old_string: { description: `PREFERRED. The EXACT existing text to replace (copy it verbatim from the file you read — include enough surrounding lines to be unique). Use this together with new_string for a simple, reliable single edit.` },
		new_string: { description: `PREFERRED. The replacement text for old_string. To delete, pass an empty string. Required when old_string is given.` },
		search_replace_blocks: { description: replaceTool_description },
	},
	approvalType: 'edits',
};
