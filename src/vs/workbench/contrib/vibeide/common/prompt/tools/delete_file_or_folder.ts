/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef, uriParam } from './_helpers.js';

export const DELETE_FILE_OR_FOLDER_TOOL: ToolDef<'delete_file_or_folder'> = {
	name: 'delete_file_or_folder',
	description: `Delete a file or folder at the given path.`,
	params: {
		...uriParam('file or folder'),
		is_recursive: { description: 'Optional. Return true to delete recursively.' },
	},
	approvalType: 'edits',
};
