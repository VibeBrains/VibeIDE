/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ToolDef, uriParam } from './_helpers.js';

export const CREATE_FILE_OR_FOLDER_TOOL: ToolDef<'create_file_or_folder'> = {
	name: 'create_file_or_folder',
	description: `Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.`,
	params: {
		...uriParam('file or folder'),
	},
	approvalType: 'edits',
};
