/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


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
