/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { ToolDef, uriParam } from './_helpers.js';

export const OPEN_FILE_TOOL: ToolDef<'open_file'> = {
	name: 'open_file',
	description: `Opens a file in the editor. Use this when the user asks to "open" a file.`,
	params: {
		...uriParam('file'),
	},
};
