/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const REWRITE_FILE_TOOL: ToolDef<'rewrite_file'> = {
	name: 'rewrite_file',
	description: `Edits a file, deleting all the old contents and replacing them with your new contents. You MUST provide the COMPLETE new file content — rewrite_file re-emits the ENTIRE file, so partial/truncated content overwrites and loses the rest. Best for files you just created or small files. For a targeted change to an existing or large file, use edit_file instead (re-emitting a whole large file risks truncating it). NEVER write a separate script (e.g. a Python/shell one-liner) to string-replace or patch a file's contents — always use edit_file or rewrite_file directly.`,
	params: {
		...uriParam('file'),
		new_content: { description: `The new contents of the file. Must be a string.` },
	},
	approvalType: 'edits',
};
