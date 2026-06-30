/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const CREATE_FILE_OR_FOLDER_TOOL: ToolDef<'create_file_or_folder'> = {
	name: 'create_file_or_folder',
	description: `Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash. NOTE: a created file is EMPTY (0 bytes) — this tool does not accept content. To create a file WITH contents in one step, skip this tool and call rewrite_file directly (it creates the file if it does not exist). Only use this tool for empty files or folders. Do not report a file as written until you have actually written its contents.`,
	params: {
		...uriParam('file or folder'),
	},
	approvalType: 'edits',
};
