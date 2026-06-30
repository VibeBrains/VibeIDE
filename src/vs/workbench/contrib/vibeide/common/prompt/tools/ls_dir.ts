/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { paginationParam, ToolDef } from './_helpers.js';

export const LS_DIR_TOOL: ToolDef<'ls_dir'> = {
	name: 'ls_dir',
	description: `Lists files and folders in the given URI (one level deep, paginated). NEVER use run_command with ls/dir/Get-ChildItem — those duplicate this functionality and recursive forms blow up stdout. For recursive views use get_dir_tree; for pattern matching use glob.`,
	params: {
		uri: { description: `Optional. The FULL path to the folder. Leave this as empty or "" to search all folders.` },
		...paginationParam,
	},
};
