/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const GET_DIR_TREE_TOOL: ToolDef<'get_dir_tree'> = {
	name: 'get_dir_tree',
	description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
	params: {
		...uriParam('folder'),
	},
};
